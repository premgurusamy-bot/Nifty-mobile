/**
 * Live order execution for the option-buying engine (LIVE mode).
 *
 * Safety model:
 *  - Entries are never automatic: only `enter()` (the app's ENTER button) buys.
 *  - Every live entry gets an exchange-side STOP_LOSS sell order at the plan's
 *    SL, so the position stays protected even when the app is closed.
 *  - While the app runs, the engine's T1 (book half, trail SL to breakeven),
 *    T2 and trailing-SL exits are mirrored with real market orders, and a stop
 *    order that filled at the exchange closes the engine position.
 *
 * No Node-only imports: runs inside the app (phone talks to Dhan directly).
 */
import { validateLimit, type EngineRunner } from '../src/lib/engine/runner.ts';
import { catalogEntry } from '../src/lib/engine/catalog.ts';
import { sideOf, type EngineConfig, type EngineState, type LiveLegs, type OpenPosition, type TradePlan } from '../src/lib/engine/types.ts';
import { optionId } from '../src/lib/instruments.ts';
import type { DhanClient } from './dhan.ts';
import { roundToTick } from './mapping.ts';
import { underlyingFor, type DhanService } from './service.ts';

const FILL_TIMEOUT_MS = 15_000;
const FILL_POLL_MS = 1000;

export interface Fill {
  orderId: string;
  status: string;
  avgPrice: number;
  filledQty: number;
}

const upper = (s: unknown) => String(s ?? '').toUpperCase();
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Stop-loss limit price beyond the trigger, so it still fills on a fast move.
 * Options (sell stop): 5% / min 0.50 below. Futures: 0.1% / min 5 ticks beyond
 * the trigger, below for a long's sell stop, above for a short's buy stop.
 */
export function stopLimitPrice(trigger: number, o: { side?: 1 | -1; tick?: number; futures?: boolean } = {}) {
  const tick = o.tick ?? 0.05;
  const side = o.side ?? 1;
  const buffer = o.futures ? Math.max(5 * tick, trigger * 0.001) : Math.max(0.5, trigger * 0.05);
  return Math.max(tick, roundToTick(trigger - side * buffer, tick));
}

/** Order routing for the selected instrument. */
interface OrderCtx {
  segment: string;
  product: string;
  tick: number;
  futures: boolean;
}
const ctxOf = (cfg: EngineConfig): OrderCtx => ({
  segment: cfg.tradeSegment || 'NSE_FNO',
  product: cfg.liveProduct,
  tick: cfg.tickSize || 0.05,
  futures: cfg.instrumentKind === 'MCX_FUTURES',
});
/** Opening order side: options are always bought; futures shorts are sold. */
const openSide = (side: 1 | -1) => (side > 0 ? 'BUY' : 'SELL') as 'BUY' | 'SELL';
const closeSide = (side: 1 | -1) => (side > 0 ? 'SELL' : 'BUY') as 'BUY' | 'SELL';

export class LiveTrader {
  private dhan: DhanClient;
  private service: DhanService;
  private sleep: (ms: number) => Promise<void>;
  /** Stops the reconcile step from racing a manual ENTER/EXIT. */
  private busy = false;

  constructor(dhan: DhanClient, service: DhanService, opts: { sleep?: (ms: number) => Promise<void> } = {}) {
    this.dhan = dhan;
    this.service = service;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async order(orderId: string): Promise<any> {
    const o = await this.dhan.order(orderId);
    return Array.isArray(o) ? o[0] : o;
  }

  /** Poll until the order is TRADED (or definitively not). */
  async waitFill(orderId: string, timeoutMs = FILL_TIMEOUT_MS): Promise<Fill> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const o = await this.order(orderId);
      const status = upper(o?.orderStatus);
      if (status === 'TRADED') {
        return {
          orderId,
          status,
          avgPrice: num(o.averageTradedPrice) || num(o.price),
          filledQty: num(o.filledQty) || num(o.quantity),
        };
      }
      if (status === 'REJECTED' || status === 'CANCELLED' || status === 'EXPIRED') {
        throw new Error(`Order ${orderId} ${status}${o?.omsErrorDescription ? `: ${o.omsErrorDescription}` : ''}`);
      }
      if (Date.now() > until)
        throw new Error(`Order ${orderId} not filled yet (${status || 'unknown'}) — check Dhan → Orders`);
      await this.sleep(FILL_POLL_MS);
    }
  }

  /** Dhan security id of what the plan trades: the option strike, or the current MCX contract. */
  async securityIdFor(
    cfg: EngineConfig,
    plan: Pick<TradePlan, 'direction' | 'strike'>,
    expiry: string,
  ): Promise<string> {
    if (cfg.instrumentKind === 'MCX_FUTURES') {
      if (!cfg.futSecurityId) throw new Error(`No ${cfg.symbol} contract resolved yet — tap Refresh now first`);
      return cfg.futSecurityId;
    }
    if (plan.direction !== 'CE' && plan.direction !== 'PE') throw new Error('Option plan expected');
    const id = optionId({ underlying: cfg.symbol, expiry, strike: plan.strike, type: plan.direction });
    let ref = this.service.toDhan(id);
    if (!ref) {
      await this.service.optionChain(expiry, underlyingFor(cfg.symbol)); // learns security ids from Dhan's chain
      ref = this.service.toDhan(id);
    }
    if (!ref) throw new Error(`No Dhan security id for ${cfg.symbol} ${expiry} ${plan.strike} ${plan.direction}`);
    return ref.securityId;
  }

  /**
   * Quantity: NSE options in units (multiples of the lot); MCX in lots — Dhan's
   * SDK example orders MCX Gold with quantity=1. The engine's MCX quantities are lots.
   */
  private async marketOrder(securityId: string, side: 'BUY' | 'SELL', qty: number, c: OrderCtx): Promise<Fill> {
    const res = await this.dhan.placeOrder({
      securityId,
      exchangeSegment: c.segment,
      transactionType: side,
      quantity: qty,
      orderType: 'MARKET',
      productType: c.product,
      price: 0,
    });
    return this.waitFill(String(res.orderId));
  }

  /** Protective stop for a position of `posSide` (+1 long → SELL stop below; -1 short → BUY stop above). */
  private async placeStop(securityId: string, qty: number, trigger: number, posSide: 1 | -1, c: OrderCtx): Promise<string> {
    const t = roundToTick(trigger, c.tick);
    const res = await this.dhan.placeOrder({
      securityId,
      exchangeSegment: c.segment,
      transactionType: closeSide(posSide),
      quantity: qty,
      orderType: 'STOP_LOSS',
      productType: c.product,
      price: stopLimitPrice(t, { side: posSide, tick: c.tick, futures: c.futures }),
      triggerPrice: t,
    });
    return String(res.orderId);
  }

  private async cancelQuietly(orderId: string | null) {
    if (!orderId) return;
    try {
      await this.dhan.cancelOrder(orderId);
    } catch {
      /* already traded / cancelled */
    }
  }

  /**
   * Manual ENTER in LIVE mode. No limit: market buy. With a limit: a LIMIT buy
   * at that price, which stays pending at Dhan until it fills (checked on every
   * refresh) or you cancel it. Either way the protective stop goes in on fill.
   */
  async enter(runner: EngineRunner, limit?: number): Promise<OpenPosition | null> {
    if (this.busy) throw new Error('Another live order is in progress');
    if (runner.state.pendingEntry) throw new Error('An entry order is already pending — cancel it first.');
    this.busy = true;
    try {
      const cfg = runner.config;
      if (!catalogEntry(cfg.symbol)) throw new Error(`Live trading isn't set up for ${cfg.symbol}`);
      const c = ctxOf(cfg);
      const plan = runner.entryPlan();
      const expiry = runner.dashboard?.expiry || cfg.futExpiry;
      if (!expiry && !c.futures) throw new Error('No expiry — tap Refresh now first');
      const securityId = await this.securityIdFor(cfg, plan, expiry);
      const side = sideOf(plan.direction);
      if (limit == null) {
        const fill = await this.marketOrder(securityId, openSide(side), plan.qty, c);
        return await this.opened(runner, plan, securityId, fill);
      }
      validateLimit(limit, c.tick);
      const res = await this.dhan.placeOrder({
        securityId,
        exchangeSegment: c.segment,
        transactionType: openSide(side),
        quantity: plan.qty,
        orderType: 'LIMIT',
        productType: c.product,
        price: roundToTick(limit, c.tick),
      });
      const orderId = String(res.orderId);
      await runner.setPendingEntry({
        plan,
        limit: roundToTick(limit, c.tick),
        placedAt: Date.now(),
        live: { securityId, orderId },
      });
      // A marketable limit fills at once — open straight away if so.
      const o = await this.order(orderId).catch(() => null);
      if (upper(o?.orderStatus) === 'TRADED')
        return await this.opened(runner, plan, securityId, this.fillOf(orderId, o));
      return null;
    } finally {
      this.busy = false;
    }
  }

  private fillOf(orderId: string, o: any): Fill {
    const status = upper(o?.orderStatus);
    return {
      orderId,
      status,
      avgPrice: num(o?.averageTradedPrice) || num(o?.price),
      // Only a fully TRADED order may fall back to its order quantity.
      filledQty: num(o?.filledQty) || (status === 'TRADED' ? num(o?.quantity) : 0),
    };
  }

  /** Entry filled: open the engine position at the real fill, then place the protective stop. */
  private async opened(runner: EngineRunner, plan: TradePlan, securityId: string, buy: Fill) {
    const live: LiveLegs = { securityId, entryOrderId: buy.orderId, slOrderId: null };
    const limitNote = runner.state.pendingEntry
      ? `limit ${runner.state.pendingEntry.limit.toFixed(2)} filled`
      : undefined;
    const pos = await runner.manualEnter({ plan, entry: buy.avgPrice, qty: buy.filledQty, live, reason: limitNote });
    try {
      const sl = await this.placeStop(securityId, pos.remainingQty, pos.currentSl, pos.side ?? 1, ctxOf(runner.config));
      await runner.patchPosition({ live: { ...live, slOrderId: sl } });
    } catch (e) {
      runner.status = `Entered, but the stop-loss order failed: ${(e as Error).message} — place one in Dhan now`;
    }
    return runner.state.position!;
  }

  /** Cancel a pending limit entry (if it filled meanwhile, the position is opened instead). */
  async cancelEntry(runner: EngineRunner) {
    const pe = runner.state.pendingEntry;
    if (!pe) return;
    if (!pe.live) return runner.setPendingEntry(null);
    if (this.busy) throw new Error('Another live order is in progress');
    this.busy = true;
    try {
      await this.cancelQuietly(pe.live.orderId);
      const o = await this.order(pe.live.orderId).catch(() => null);
      const f = this.fillOf(pe.live.orderId, o);
      if (f.filledQty > 0) {
        // Filled (fully, or partly before the cancel landed): that quantity is a real position.
        await this.opened(runner, pe.plan, pe.live.securityId, f);
        runner.status = `The limit order had already filled (${f.filledQty} @ ${f.avgPrice.toFixed(2)}) — position opened`;
        return;
      }
      await runner.setPendingEntry(null);
    } finally {
      this.busy = false;
    }
  }

  /** On every refresh: has the pending limit entry filled at Dhan? */
  private async checkPendingEntry(runner: EngineRunner) {
    const pe = runner.state.pendingEntry;
    if (!pe?.live) return;
    const o = await this.order(pe.live.orderId).catch(() => null);
    if (!o) return;
    const f = this.fillOf(pe.live.orderId, o);
    if (f.status === 'TRADED') {
      await this.opened(runner, pe.plan, pe.live.securityId, f);
    } else if (f.status === 'CANCELLED' || f.status === 'EXPIRED' || f.status === 'REJECTED') {
      if (f.filledQty > 0) await this.opened(runner, pe.plan, pe.live.securityId, f);
      else {
        await runner.setPendingEntry(null);
        runner.status = `Limit entry ${f.status.toLowerCase()}${o.omsErrorDescription ? `: ${o.omsErrorDescription}` : ''}`;
      }
    }
  }

  /** Manual EXIT: cancel the stop, sell what's left at market. */
  async exit(runner: EngineRunner, reason = 'MANUAL EXIT') {
    const p = runner.state.position;
    if (!p) throw new Error('No open position');
    if (!p.live) return runner.manualExit({ reason });
    if (this.busy) throw new Error('Another live order is in progress');
    this.busy = true;
    try {
      const stopFill = await this.stopFilled(p.live.slOrderId);
      if (stopFill) return runner.manualExit({ price: stopFill.avgPrice, reason: 'SL HIT (exchange stop order)' });
      await this.cancelQuietly(p.live.slOrderId);
      const fill = await this.marketOrder(p.live.securityId, closeSide(p.side ?? 1), p.remainingQty, ctxOf(runner.config));
      await runner.manualExit({ price: fill.avgPrice, reason: `${reason} (live fill)` });
    } finally {
      this.busy = false;
    }
  }

  private async stopFilled(slOrderId: string | null): Promise<Fill | null> {
    if (!slOrderId) return null;
    try {
      const o = await this.order(slOrderId);
      if (upper(o?.orderStatus) !== 'TRADED') return null;
      return {
        orderId: slOrderId,
        status: 'TRADED',
        avgPrice: num(o.averageTradedPrice) || num(o.price),
        filledQty: num(o.filledQty),
      };
    } catch {
      return null;
    }
  }

  /**
   * After each engine cycle: mirror what the engine did to a live position.
   * `before` is the state going into the cycle, `after` the result.
   */
  async afterCycle(runner: EngineRunner, before: EngineState, after: EngineState) {
    if (this.busy) return;
    if (!after.position && after.pendingEntry?.live) {
      this.busy = true;
      try {
        await this.checkPendingEntry(runner);
      } finally {
        this.busy = false;
      }
      return;
    }
    const prev = before.position;
    if (!prev?.live) return;
    const c = ctxOf(runner.config);
    const side = prev.side ?? 1;
    const live = prev.live;
    this.busy = true;
    try {
      if (!after.position) {
        // Engine closed it (SL / T2 / trailing SL / single-lot T1): make it real, journal the real fill.
        const stop = await this.stopFilled(live.slOrderId);
        if (stop) {
          await runner.amendExit(prev, stop.avgPrice, 'exchange stop fill');
          return;
        }
        await this.cancelQuietly(live.slOrderId);
        const fill = await this.marketOrder(live.securityId, closeSide(side), prev.remainingQty, c);
        await runner.amendExit(prev, fill.avgPrice, 'live fill');
        return;
      }
      const cur = after.position;
      if (!prev.partialBooked && cur.partialBooked) {
        // T1: book half at market, re-protect the rest at breakeven.
        await this.cancelQuietly(live.slOrderId);
        await this.marketOrder(live.securityId, closeSide(side), cur.partialQty, c);
        const sl = await this.placeStop(live.securityId, cur.remainingQty, cur.currentSl, side, c);
        await runner.patchPosition({ live: { ...live, slOrderId: sl } });
        return;
      }
      // Still open: did the exchange stop fire while we weren't looking?
      const filled = await this.stopFilled(live.slOrderId);
      if (!filled && side * (cur.currentSl - prev.currentSl) > 1e-9) {
        // Profit lock raised the stop: replace the exchange stop at the new level.
        await this.cancelQuietly(live.slOrderId);
        const late = await this.stopFilled(live.slOrderId);
        if (late) {
          this.busy = false;
          await runner.manualExit({ price: late.avgPrice, reason: 'SL HIT (exchange stop order)' });
          return;
        }
        const sl = await this.placeStop(live.securityId, cur.remainingQty, cur.currentSl, side, c);
        await runner.patchPosition({ live: { ...live, slOrderId: sl } });
        return;
      }
      if (filled) {
        this.busy = false;
        await runner.manualExit({ price: filled.avgPrice, reason: 'SL HIT (exchange stop order)' });
        return;
      }
      if (live.slOrderId) {
        const o = await this.order(live.slOrderId).catch(() => null);
        const st = upper(o?.orderStatus);
        if ((st === 'CANCELLED' || st === 'EXPIRED' || st === 'REJECTED') && runner.marketOpen()) {
          // e.g. a DAY stop expired overnight on a carried position — put it back.
          const sl = await this.placeStop(live.securityId, cur.remainingQty, cur.currentSl, side, c);
          await runner.patchPosition({ live: { ...live, slOrderId: sl } });
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
