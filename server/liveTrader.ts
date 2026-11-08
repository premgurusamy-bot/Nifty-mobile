/**
 * Live order execution for the option-buying engine (LIVE mode).
 *
 * Safety model:
 *  - Entries: the app's ENTER button, or the LIVE automatic switch. A market entry that isn't
 *    filled within the fill window (default 5 s) is cancelled; a part that filled is kept.
 *  - Each index's orders go to its broker (Dhan, or Angel One for the indexes set to it). With
 *    "switch broker" on, an entry the broker certainly didn't take (not logged in, refused,
 *    rejected, or not filled and cancelled with nothing filled) goes to the other broker at once.
 *    When it is unclear whether an order was placed (no reply), it does NOT switch: two orders
 *    would be worse than one missed entry.
 *  - Every live entry gets an exchange-side STOP_LOSS order at the plan's SL with the same broker,
 *    so the position stays protected even when the app is closed.
 *  - While the app runs, the engine's T1 (book half, trail SL to breakeven), T2, trailing-SL and
 *    profit-lock moves are mirrored with real orders at that broker, and a stop order that filled
 *    at the exchange closes the engine position.
 *
 * No Node-only imports: runs inside the app (phone talks to the brokers directly).
 */
import { validateLimit, type EngineRunner } from '../src/lib/engine/runner.ts';
import { catalogEntry } from '../src/lib/engine/catalog.ts';
import { sideOf, type EngineConfig, type EngineState, type LiveLegs, type OpenPosition, type TradePlan } from '../src/lib/engine/types.ts';
import { DhanGateway, isRefused, isUnclear, type BrokerName, type Instrument, type OrderGateway, type PlaceArgs } from './brokers.ts';
import type { DhanClient } from './dhan.ts';
import { roundToTick } from './mapping.ts';
import type { DhanService } from './service.ts';

const FILL_TIMEOUT_MS = 15_000;
const FILL_POLL_MS = 1000;
/** Entries poll faster: the fill window is short (Settings, default 5 s). */
const ENTRY_POLL_MS = 500;

export interface Fill {
  orderId: string;
  status: string;
  avgPrice: number;
  filledQty: number;
}

/** The entry certainly didn't happen at this broker (nothing open there): safe to try the other one. */
class NoEntry extends Error {}

const upper = (s: unknown) => String(s ?? '').toUpperCase();
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const brokerLabel = (b: BrokerName) => (b === 'ANGEL' ? 'Angel One' : 'Dhan');

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
  product: 'INTRADAY' | 'MARGIN';
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
const instOf = (l: { securityId: string; tradingSymbol?: string }): Instrument => ({
  securityId: l.securityId,
  ...(l.tradingSymbol ? { tradingSymbol: l.tradingSymbol } : {}),
});

export class LiveTrader {
  private gateways: Partial<Record<BrokerName, OrderGateway>>;
  private sleep: (ms: number) => Promise<void>;
  /** Stops the reconcile step from racing a manual ENTER/EXIT. */
  private busy = false;

  constructor(
    dhan: DhanClient,
    service: DhanService,
    opts: { sleep?: (ms: number) => Promise<void>; angel?: OrderGateway; dhanGateway?: OrderGateway } = {},
  ) {
    this.gateways = { DHAN: opts.dhanGateway ?? new DhanGateway(dhan, service), ...(opts.angel ? { ANGEL: opts.angel } : {}) };
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private gw(b: BrokerName | undefined): OrderGateway {
    const g = this.gateways[b ?? 'DHAN'];
    if (!g) throw new Error(`${brokerLabel(b ?? 'DHAN')} orders aren't available in this app`);
    return g;
  }

  /** The index's broker first, then (switch on) the other one. */
  brokersFor(cfg: EngineConfig): BrokerName[] {
    const own: BrokerName = (cfg.angelOrderSymbols ?? []).includes(cfg.symbol) && cfg.instrumentKind === 'INDEX_OPTIONS' ? 'ANGEL' : 'DHAN';
    const other: BrokerName = own === 'ANGEL' ? 'DHAN' : 'ANGEL';
    const canOther = cfg.brokerFailover !== false && !!this.gateways[other] && (other === 'DHAN' || cfg.instrumentKind === 'INDEX_OPTIONS');
    return canOther ? [own, other] : [own];
  }

  /** Poll until the order is TRADED (or definitively not). */
  async waitFill(gw: OrderGateway, orderId: string, timeoutMs = FILL_TIMEOUT_MS, pollMs = FILL_POLL_MS): Promise<Fill> {
    const until = Date.now() + timeoutMs;
    let waited = 0; // also counted, so an injected (test) sleep ends the wait too
    for (;;) {
      const o = await gw.order(orderId).catch(() => null);
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
        const msg = `${brokerLabel(gw.name)} order ${orderId} ${status}${o?.omsErrorDescription ? `: ${o.omsErrorDescription}` : ''}`;
        throw num(o?.filledQty) > 0 ? new Error(msg) : new NoEntry(msg);
      }
      if (Date.now() > until || waited >= timeoutMs)
        throw new Error(`Order ${orderId} not filled yet (${status || 'unknown'}) — check ${brokerLabel(gw.name)} → Orders`);
      await this.sleep(pollMs);
      waited += pollMs;
    }
  }

  /** Dhan security id of what the plan trades (the app's position ticker uses it). */
  async securityIdFor(cfg: EngineConfig, plan: Pick<TradePlan, 'direction' | 'strike'>, expiry: string): Promise<string> {
    return (await this.gw('DHAN').instrument(cfg, plan, expiry)).securityId;
  }

  private args(inst: Instrument, side: 'BUY' | 'SELL', qty: number, c: OrderCtx, type: PlaceArgs['type'], price = 0, trigger?: number): PlaceArgs {
    return { inst, segment: c.segment, side, qty, type, price, product: c.product, ...(trigger != null ? { trigger } : {}) };
  }

  /**
   * Quantity: NSE options in units (multiples of the lot); MCX in lots — Dhan's
   * SDK example orders MCX Gold with quantity=1. The engine's MCX quantities are lots.
   */
  private async marketOrder(gw: OrderGateway, inst: Instrument, side: 'BUY' | 'SELL', qty: number, c: OrderCtx): Promise<Fill> {
    const id = await gw.place(this.args(inst, side, qty, c, 'MARKET'));
    return this.waitFill(gw, id);
  }

  /**
   * Market entry with a fill window: filled within `seconds` → keep it. Not (fully) filled by
   * then → cancel the order; a part that did fill is kept (it is a real position and gets its
   * stop). NoEntry when the broker certainly holds nothing (safe to try the other broker).
   */
  private async marketEntry(gw: OrderGateway, inst: Instrument, side: 'BUY' | 'SELL', qty: number, c: OrderCtx, seconds: number): Promise<Fill> {
    const a = this.args(inst, side, qty, c, 'MARKET');
    const t0 = Date.now();
    let orderId: string;
    try {
      orderId = await gw.place(a);
    } catch (e) {
      if (isRefused(e)) throw new NoEntry((e as Error).message);
      if (!isUnclear(e)) throw e;
      // No reply: look whether it reached the broker before deciding anything.
      await this.sleep(1500);
      const found = await gw.findRecent(a, t0);
      if (found === null) throw new NoEntry(`${(e as Error).message} (no order placed)`);
      throw new Error(
        `${(e as Error).message} — the order ${found ? `may have been placed (${found})` : 'may or may not have been placed'}: check ${brokerLabel(gw.name)} → Orders`,
      );
    }
    try {
      return await this.waitFill(gw, orderId, seconds * 1000, ENTRY_POLL_MS);
    } catch (e) {
      if (!/not filled yet/.test((e as Error).message)) throw e; // rejected / cancelled: nothing to undo
    }
    await this.cancelQuietly(gw, orderId);
    const o = await gw.order(orderId).catch(() => null);
    const f = this.fillOf(orderId, o);
    if (f.filledQty > 0) return f; // filled (fully, or partly) before the cancel landed
    if (!o)
      throw new Error(
        `Order ${orderId} not filled in ${seconds} s — cancel sent, but its status couldn't be read: check ${brokerLabel(gw.name)} → Orders`,
      );
    throw new NoEntry(`Order ${orderId} not filled in ${seconds} s — cancelled, no trade`);
  }

  /** Protective stop for a position of `posSide` (+1 long → SELL stop below; -1 short → BUY stop above). */
  private async placeStop(gw: OrderGateway, inst: Instrument, qty: number, trigger: number, posSide: 1 | -1, c: OrderCtx): Promise<string> {
    const t = roundToTick(trigger, c.tick);
    return gw.place(
      this.args(inst, closeSide(posSide), qty, c, 'STOP_LOSS', stopLimitPrice(t, { side: posSide, tick: c.tick, futures: c.futures }), t),
    );
  }

  private async cancelQuietly(gw: OrderGateway, orderId: string | null) {
    if (!orderId) return;
    try {
      await gw.cancel(orderId);
    } catch {
      /* already traded / cancelled */
    }
  }

  /**
   * ENTER in LIVE mode. No limit: market order (switching broker if the first can't take it).
   * With a limit: a LIMIT order at that price with the index's broker, pending until it fills
   * (checked on every refresh) or you cancel it. Either way the protective stop goes in on fill.
   */
  async enter(runner: EngineRunner, limit?: number, opts: { auto?: boolean } = {}): Promise<OpenPosition | null> {
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
      const side = sideOf(plan.direction);
      const order = this.brokersFor(cfg);

      if (limit != null) {
        validateLimit(limit, c.tick);
        const gw = this.gw(order.find((b) => this.gw(b).ready()) ?? order[0]);
        if (!gw.ready()) throw new Error(`${brokerLabel(gw.name)} is not logged in`);
        const inst = await gw.instrument(cfg, plan, expiry);
        const orderId = await gw.place(this.args(inst, openSide(side), plan.qty, c, 'LIMIT', roundToTick(limit, c.tick)));
        await runner.setPendingEntry({
          plan,
          limit: roundToTick(limit, c.tick),
          placedAt: Date.now(),
          live: { securityId: inst.securityId, orderId, broker: gw.name, ...(inst.tradingSymbol ? { tradingSymbol: inst.tradingSymbol } : {}) },
        });
        // A marketable limit fills at once — open straight away if so.
        const o = await gw.order(orderId).catch(() => null);
        if (upper(o?.orderStatus) === 'TRADED') return await this.opened(runner, gw, plan, inst, this.fillOf(orderId, o));
        return null;
      }

      const notes: string[] = [];
      for (const b of order) {
        const gw = this.gw(b);
        if (!gw.ready()) {
          notes.push(`${brokerLabel(b)}: not logged in`);
          continue;
        }
        try {
          const inst = await gw.instrument(cfg, plan, expiry).catch((e) => {
            throw new NoEntry((e as Error).message);
          });
          const fill = await this.marketEntry(gw, inst, openSide(side), plan.qty, c, cfg.entryFillSeconds ?? 5);
          const pos = await this.opened(runner, gw, plan, inst, fill, opts.auto);
          const via = b !== order[0] ? ` via ${brokerLabel(b)} (${notes.join('; ')})` : '';
          if (fill.filledQty < plan.qty)
            runner.status = `Entry partly filled (${fill.filledQty} of ${plan.qty}) — the rest was cancelled; stop placed for ${fill.filledQty}${via}`;
          else if (via) runner.status = `Entered${via}`;
          return pos;
        } catch (e) {
          if (!(e instanceof NoEntry)) throw e; // unclear / partly live: never place a second order
          notes.push(`${brokerLabel(b)}: ${(e as Error).message}`);
        }
      }
      throw new Error(`Entry not placed — ${notes.join('; ')}`);
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
  private async opened(runner: EngineRunner, gw: OrderGateway, plan: TradePlan, inst: Instrument, buy: Fill, auto = false) {
    const live: LiveLegs = {
      ...(gw.name !== 'DHAN' ? { broker: gw.name } : {}),
      securityId: inst.securityId,
      ...(inst.tradingSymbol ? { tradingSymbol: inst.tradingSymbol } : {}),
      entryOrderId: buy.orderId,
      slOrderId: null,
    };
    const limitNote = runner.state.pendingEntry ? `limit ${runner.state.pendingEntry.limit.toFixed(2)} filled` : undefined;
    const via = gw.name === 'ANGEL' ? 'Angel One' : undefined;
    const reason = [limitNote, via].filter(Boolean).join(' · ') || undefined;
    const pos = await runner.manualEnter({ plan, entry: buy.avgPrice, qty: buy.filledQty, live, reason, auto });
    try {
      const sl = await this.placeStop(gw, inst, pos.remainingQty, pos.currentSl, pos.side ?? 1, ctxOf(runner.config));
      await runner.patchPosition({ live: { ...live, slOrderId: sl } });
    } catch (e) {
      runner.status = `Entered, but the stop-loss order failed: ${(e as Error).message} — place one in ${brokerLabel(gw.name)} now`;
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
      const gw = this.gw(pe.live.broker);
      await this.cancelQuietly(gw, pe.live.orderId);
      const o = await gw.order(pe.live.orderId).catch(() => null);
      const f = this.fillOf(pe.live.orderId, o);
      if (f.filledQty > 0) {
        // Filled (fully, or partly before the cancel landed): that quantity is a real position.
        await this.opened(runner, gw, pe.plan, instOf(pe.live), f);
        runner.status = `The limit order had already filled (${f.filledQty} @ ${f.avgPrice.toFixed(2)}) — position opened`;
        return;
      }
      await runner.setPendingEntry(null);
    } finally {
      this.busy = false;
    }
  }

  /** On every refresh: has the pending limit entry filled? */
  private async checkPendingEntry(runner: EngineRunner) {
    const pe = runner.state.pendingEntry;
    if (!pe?.live) return;
    const gw = this.gw(pe.live.broker);
    const o = await gw.order(pe.live.orderId).catch(() => null);
    if (!o) return;
    const f = this.fillOf(pe.live.orderId, o);
    if (f.status === 'TRADED') {
      await this.opened(runner, gw, pe.plan, instOf(pe.live), f);
    } else if (f.status === 'CANCELLED' || f.status === 'EXPIRED' || f.status === 'REJECTED') {
      if (f.filledQty > 0) await this.opened(runner, gw, pe.plan, instOf(pe.live), f);
      else {
        await runner.setPendingEntry(null);
        runner.status = `Limit entry ${f.status.toLowerCase()}${o.omsErrorDescription ? `: ${o.omsErrorDescription}` : ''}`;
      }
    }
  }

  /** Manual EXIT: cancel the stop, sell what's left at market (with the broker holding it). */
  async exit(runner: EngineRunner, reason = 'MANUAL EXIT') {
    const p = runner.state.position;
    if (!p) throw new Error('No open position');
    if (!p.live) return runner.manualExit({ reason });
    if (this.busy) throw new Error('Another live order is in progress');
    this.busy = true;
    try {
      const gw = this.gw(p.live.broker);
      const stopFill = await this.stopFilled(gw, p.live.slOrderId);
      if (stopFill) return runner.manualExit({ price: stopFill.avgPrice, reason: 'SL HIT (exchange stop order)' });
      await this.cancelQuietly(gw, p.live.slOrderId);
      const fill = await this.marketOrder(gw, instOf(p.live), closeSide(p.side ?? 1), p.remainingQty, ctxOf(runner.config));
      await runner.manualExit({ price: fill.avgPrice, reason: `${reason} (live fill)` });
    } finally {
      this.busy = false;
    }
  }

  private async stopFilled(gw: OrderGateway, slOrderId: string | null): Promise<Fill | null> {
    if (!slOrderId) return null;
    try {
      const o = await gw.order(slOrderId);
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
    // LIVE automatic entry: this cycle confirmed a new signal and the switch is on.
    const auto = runner.takeAutoRequest();
    if (auto && !this.busy) {
      const cfg = runner.config;
      if (cfg.tradeMode === 'LIVE' && cfg.autoEntryLive && !runner.state.position && !runner.state.pendingEntry) {
        try {
          // Same path as tapping ENTER at market: every gate (time cutoff, daily limits, premium
          // filters, lot cap, capital) is checked again, and the exchange stop-loss goes in on fill.
          const pos = await this.enter(runner, undefined, { auto: true });
          if (pos && !/^Entry partly filled|^Entered via/.test(runner.status))
            runner.status = `Automatic LIVE entry filled: ${pos.remainingQty} @ ${pos.entry.toFixed(2)}${pos.live?.broker === 'ANGEL' ? ' (Angel One)' : ''}`;
        } catch (e) {
          runner.status = `Live order error - automatic entry failed: ${(e as Error).message}`;
        }
        return;
      }
    }
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
    const gw = this.gw(live.broker);
    const inst = instOf(live);
    this.busy = true;
    try {
      if (!after.position) {
        // Engine closed it (SL / T2 / trailing SL / single-lot T1): make it real, journal the real fill.
        const stop = await this.stopFilled(gw, live.slOrderId);
        if (stop) {
          await runner.amendExit(prev, stop.avgPrice, 'exchange stop fill');
          return;
        }
        await this.cancelQuietly(gw, live.slOrderId);
        const fill = await this.marketOrder(gw, inst, closeSide(side), prev.remainingQty, c);
        await runner.amendExit(prev, fill.avgPrice, 'live fill');
        return;
      }
      const cur = after.position;
      if (!prev.partialBooked && cur.partialBooked) {
        // T1: book half at market, re-protect the rest at breakeven.
        await this.cancelQuietly(gw, live.slOrderId);
        await this.marketOrder(gw, inst, closeSide(side), cur.partialQty, c);
        const sl = await this.placeStop(gw, inst, cur.remainingQty, cur.currentSl, side, c);
        await runner.patchPosition({ live: { ...live, slOrderId: sl } });
        return;
      }
      // Still open: did the exchange stop fire while we weren't looking?
      const filled = await this.stopFilled(gw, live.slOrderId);
      if (!filled && side * (cur.currentSl - prev.currentSl) > 1e-9) {
        // Profit lock / loss trail raised the stop: replace the exchange stop at the new level.
        await this.cancelQuietly(gw, live.slOrderId);
        const late = await this.stopFilled(gw, live.slOrderId);
        if (late) {
          this.busy = false;
          await runner.manualExit({ price: late.avgPrice, reason: 'SL HIT (exchange stop order)' });
          return;
        }
        const sl = await this.placeStop(gw, inst, cur.remainingQty, cur.currentSl, side, c);
        await runner.patchPosition({ live: { ...live, slOrderId: sl } });
        return;
      }
      if (filled) {
        this.busy = false;
        await runner.manualExit({ price: filled.avgPrice, reason: 'SL HIT (exchange stop order)' });
        return;
      }
      if (live.slOrderId) {
        const o = await gw.order(live.slOrderId).catch(() => null);
        const st = upper(o?.orderStatus);
        if ((st === 'CANCELLED' || st === 'EXPIRED' || st === 'REJECTED') && runner.marketOpen()) {
          // e.g. a DAY stop expired overnight on a carried position — put it back.
          const sl = await this.placeStop(gw, inst, cur.remainingQty, cur.currentSl, side, c);
          await runner.patchPosition({ live: { ...live, slOrderId: sl } });
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
