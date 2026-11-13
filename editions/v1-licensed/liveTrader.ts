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
 * Order safety (audit fixes J-1, J-2, J-4 — same rules as v2, see server/orderSafety.ts):
 *  - a cancel is never assumed: the order is read back; no closing order and no replacement stop
 *    goes in while the old stop may still be working;
 *  - before a closing SELL the stop is confirmed cancelled (or found filled — then nothing is sold),
 *    and the quantity is capped at what Dhan holds;
 *  - Dhan's positions are read (every 15 s and after a restart): a position closed outside the app
 *    closes the engine trade and its stop is cancelled; a smaller holding resizes the stop; a stop
 *    is never placed for a position that isn't there; a failed read never counts as "closed".
 *
 * No Node-only imports: runs inside the app (phone talks to Dhan directly).
 */
import { validateLimit, type EngineRunner, type EntryPick } from '../src/lib/engine/runner.ts';
import { catalogEntry } from '../src/lib/engine/catalog.ts';
import { sideOf, type EngineConfig, type EngineState, type LiveLegs, type OpenPosition, type TradePlan } from '../src/lib/engine/types.ts';
import { optionId } from '../src/lib/instruments.ts';
import { DhanError, type DhanClient } from './dhan.ts';
import { roundToTick } from './mapping.ts';
import { underlyingFor, type DhanService } from './service.ts';
import { cancelConfirmed, heldQty, type CancelOutcome, type OrderReader, type PositionRow } from './orderSafety.ts';

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

/** A closing order that didn't (fully) fill and was cancelled (confirmed): `filled` units did go. */
class ExitShort extends Error {
  filled: number;
  constructor(message: string, filled: number) {
    super(message);
    this.filled = filled;
  }
}
const filledOf = (e: unknown) => (e instanceof ExitShort ? e.filled : 0);
/** An order's fate couldn't be confirmed (cancel not confirmed, status unreadable): send nothing more. */
class Unconfirmed extends Error {}
const isUnclear = (e: unknown) => /^Cannot reach/i.test((e as Error)?.message ?? '');

type CloseResult =
  | { kind: 'STOP_FILLED'; price: number }
  | { kind: 'SOLD'; price: number }
  | { kind: 'FLAT'; price: number | null }
  | { kind: 'BLOCKED' }
  | { kind: 'FAILED'; stop: { id: string; qty: number; trigger: number } | null };
const unsure = (r: CancelOutcome) => r.state === 'ACTIVE' || r.state === 'UNKNOWN';

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
  /** Position check against Dhan (J-4): how often (real ms), and how long "flat" must last. */
  reconEveryMs = 15_000;
  flatConfirmMs = 5_000;
  /** A fresh entry may not show in Dhan's positions at once: no "flat" verdict this soon (ms). */
  freshEntryMs = 30_000;
  /** After a stop move that couldn't be done, wait this long before trying again (ms). */
  retryMs = 10_000;
  private recon = new Map<string, { at: number; zeroAt: number | null }>();
  private openedAt = new Map<string, number>();
  private retryAt = new Map<string, number>();
  private warned = new Map<string, string>();
  /** Dhan orders, as the shared safety helpers read them. */
  private readonly book: OrderReader = {
    order: (id) => this.order(id),
    cancel: async (id) => {
      await this.dhan.cancelOrder(id);
    },
  };

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

  /**
   * A closing market order. Not filled in time → cancel it and confirm what happened (J-2): never
   * leave a closing order working while a stop goes back in.
   */
  private async closeOrder(securityId: string, side: 'BUY' | 'SELL', qty: number, c: OrderCtx): Promise<Fill> {
    const res = await this.dhan.placeOrder({
      securityId,
      exchangeSegment: c.segment,
      transactionType: side,
      quantity: qty,
      orderType: 'MARKET',
      productType: c.product,
      price: 0,
    });
    const id = String(res.orderId);
    try {
      return await this.waitFill(id);
    } catch (e) {
      if (!/not filled yet/.test((e as Error).message)) throw e;
      const r = await cancelConfirmed(this.book, id, this.sleep);
      if (r.state === 'FILLED' && r.filledQty >= qty) return { orderId: id, status: 'TRADED', avgPrice: r.avgPrice, filledQty: r.filledQty };
      if (r.state === 'CANCELLED' || r.state === 'FILLED')
        throw new ExitShort(`Order ${id} not filled in time — cancelled (${r.filledQty} of ${qty} filled)`, r.filledQty);
      throw new Unconfirmed(`Order ${id} not filled in time and its cancel could not be confirmed (${r.status || 'status unknown'}) — it may still be working: check Dhan → Orders`);
    }
  }

  /**
   * Protective stop for a position of `posSide` (+1 long → SELL stop below; -1 short → BUY stop above).
   * A placement without a reply is looked up in Dhan's order book first (J-2): never doubled.
   */
  private async placeStop(securityId: string, qty: number, trigger: number, posSide: 1 | -1, c: OrderCtx): Promise<string> {
    const t = roundToTick(trigger, c.tick);
    const t0 = Date.now();
    try {
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
    } catch (e) {
      if (!isUnclear(e)) throw e;
      await this.sleep(1500);
      let list: any[] | null = null;
      try {
        list = ((await this.dhan.orders()) as any[]) ?? [];
      } catch {
        list = null;
      }
      const hit = list?.find(
        (x: any) =>
          String(x.securityId) === securityId &&
          upper(x.transactionType) === closeSide(posSide) &&
          upper(x.orderType) === 'STOP_LOSS' &&
          Number(x.quantity) === qty &&
          (!x.createTime || Date.parse(String(x.createTime).replace(' ', 'T') + '+05:30') >= t0 - 60_000),
      );
      if (hit) return String(hit.orderId);
      if (list) throw e;
      throw new Unconfirmed(`${(e as Error).message} — the stop-loss may or may not have been placed: check Dhan → Orders`);
    }
  }

  /** What the Dhan account actually holds of the instrument (J-4); null = couldn't be read. */
  private async held(securityId: string, c: OrderCtx, side: 1 | -1): Promise<{ qty: number; row: PositionRow | null } | null> {
    const positions = async (): Promise<PositionRow[]> => {
      let list: any;
      try {
        list = await this.dhan.positions();
      } catch (e) {
        // Dhan answers "no positions" with an error; anything else (no reply, token, server) is unknown.
        if (e instanceof DhanError && e.status !== 401 && e.code !== 'DH-901' && e.status < 500) return [];
        throw e;
      }
      return (Array.isArray(list) ? list : []).map((p: any) => ({
        securityId: String(p.securityId ?? ''),
        netQty: Number(p.netQty ?? 0) || 0,
        product: upper(p.productType) === 'MARGIN' ? 'MARGIN' : upper(p.productType) === 'INTRADAY' ? 'INTRADAY' : '',
        sellAvg: Number(p.sellAvg ?? 0) || 0,
      }));
    };
    return heldQty(positions, securityId, c.product, side, this.sleep);
  }

  /** Raise an alert (v1: the "Live order error" status line), once per topic until it changes. */
  private warn(runner: EngineRunner, topic: string, msg: string) {
    runner.status = `Live order error - ${msg}`;
    this.warned.set(topic, msg);
  }

  /** A closing order failed while no stop works (the old one is confirmed gone): protect what is held. */
  private async reprotect(runner: EngineRunner, securityId: string, qty: number, trigger: number, side: 1 | -1, c: OrderCtx, what: string, err: unknown) {
    const h = await this.held(securityId, c, side);
    const q = h ? h.qty : qty;
    if (!(q > 0)) {
      this.warn(runner, `reprotect:${securityId}`, `${what} FAILED at Dhan: ${(err as Error)?.message ?? err} — Dhan shows nothing left open`);
      return null;
    }
    const id = await this.placeStop(securityId, q, trigger, side, c).catch(() => null);
    this.warn(
      runner,
      `reprotect:${securityId}`,
      `${what} FAILED at Dhan: ${(err as Error)?.message ?? err} — ${q} still open at Dhan; ${id ? `stop-loss put back at ${trigger.toFixed(2)}` : 'NO stop-loss could be placed — exit it in the Dhan app NOW'}`,
    );
    return id ? { id, qty: q, trigger } : null;
  }

  /** Close a live position at Dhan safely (J-1): confirm the stop first, sell only what is held. */
  private async closeAtBroker(runner: EngineRunner, securityId: string, slOrderId: string | null, wantQty: number, trigger: number, side: 1 | -1, c: OrderCtx, what: string): Promise<CloseResult> {
    let stopPart = { qty: 0, price: 0 };
    if (slOrderId) {
      const r = await cancelConfirmed(this.book, slOrderId, this.sleep);
      if (r.state === 'FILLED') return { kind: 'STOP_FILLED', price: r.avgPrice };
      if (unsure(r)) {
        this.warn(runner, `close:${slOrderId}`, `${what} NOT sent: the stop-loss order ${slOrderId} could not be confirmed cancelled (${r.status || 'status unknown'}) — it still protects the position at Dhan. Check Dhan → Orders.`);
        return { kind: 'BLOCKED' };
      }
      stopPart = { qty: r.filledQty, price: r.avgPrice };
    }
    const h = await this.held(securityId, c, side);
    const left = wantQty - stopPart.qty;
    const qty = h == null ? left : Math.min(left, h.qty);
    if (!(qty > 0)) {
      if (stopPart.qty > 0) return { kind: 'STOP_FILLED', price: stopPart.price };
      return { kind: 'FLAT', price: h?.row?.sellAvg || null };
    }
    let fill: Fill;
    try {
      fill = await this.closeOrder(securityId, closeSide(side), qty, c);
    } catch (e) {
      if (e instanceof Unconfirmed) {
        this.warn(runner, `close:${securityId}`, `${what}: ${e.message}. No new stop-loss is placed while that order may still fill.`);
        return { kind: 'BLOCKED' };
      }
      return { kind: 'FAILED', stop: await this.reprotect(runner, securityId, qty - filledOf(e), trigger, side, c, what, e) };
    }
    const tot = stopPart.qty + fill.filledQty;
    return { kind: 'SOLD', price: tot ? (stopPart.qty * stopPart.price + fill.filledQty * fill.avgPrice) / tot : fill.avgPrice };
  }

  /** Dhan shows no position: it was closed outside the app (manual exit, auto square-off). */
  private async closedOutside(runner: EngineRunner, p: OpenPosition, price: number | null) {
    const at = price || runner.premium(p.direction, p.strike) || p.currentSl;
    await runner.manualExit({ price: at, reason: 'CLOSED OUTSIDE THE APP (Dhan shows no position — manual exit or auto square-off)' });
    runner.status = `Live order error - ${p.direction} ${p.strike}: Dhan shows no open position — closed outside the app (manual exit or auto square-off)`;
  }

  /**
   * Manual ENTER in LIVE mode. No limit: market buy. With a limit: a LIMIT buy
   * at that price, which stays pending at Dhan until it fills (checked on every
   * refresh) or you cancel it. Either way the protective stop goes in on fill.
   */
  async enter(runner: EngineRunner, limit?: number, opts: { auto?: boolean; pick?: EntryPick } = {}): Promise<OpenPosition | null> {
    if (this.busy) throw new Error('Another live order is in progress');
    if (runner.state.pendingEntry) throw new Error('An entry order is already pending — cancel it first.');
    this.busy = true;
    try {
      const cfg = runner.config;
      if (!catalogEntry(cfg.symbol)) throw new Error(`Live trading isn't set up for ${cfg.symbol}`);
      const c = ctxOf(cfg);
      // The engine's best strike, or the one picked in the Option Chain (same stop / targets / lock).
      const plan = runner.entryPlan(opts.pick);
      const expiry = runner.dashboard?.expiry || cfg.futExpiry;
      if (!expiry && !c.futures) throw new Error('No expiry — tap Refresh now first');
      const securityId = await this.securityIdFor(cfg, plan, expiry);
      const side = sideOf(plan.direction);
      if (limit == null) {
        const fill = await this.marketOrder(securityId, openSide(side), plan.qty, c);
        return await this.opened(runner, plan, securityId, fill, opts.auto);
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
  private async opened(runner: EngineRunner, plan: TradePlan, securityId: string, buy: Fill, auto = false) {
    const live: LiveLegs = { securityId, entryOrderId: buy.orderId, slOrderId: null };
    const limitNote = runner.state.pendingEntry
      ? `limit ${runner.state.pendingEntry.limit.toFixed(2)} filled`
      : undefined;
    const pos = await runner.manualEnter({ plan, entry: buy.avgPrice, qty: buy.filledQty, live, reason: limitNote, auto });
    this.openedAt.set(buy.orderId, Date.now());
    try {
      const sl = await this.placeStop(securityId, pos.remainingQty, pos.currentSl, pos.side ?? 1, ctxOf(runner.config));
      await runner.patchPosition({ live: { ...live, slOrderId: sl, slTrigger: pos.currentSl, slQty: pos.remainingQty } });
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
      // Confirm the cancel with Dhan (J-2): an order that may still be working stays tracked.
      const r = await cancelConfirmed(this.book, pe.live.orderId, this.sleep);
      if (unsure(r))
        throw new Error(`Cancel of the limit order ${pe.live.orderId} could not be confirmed (${r.status || 'status unknown'}) — it is still tracked; check Dhan → Orders`);
      const f: Fill = { orderId: pe.live.orderId, status: r.status, avgPrice: r.avgPrice, filledQty: r.filledQty };
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

  /** Manual EXIT: confirm the stop is cancelled (or found filled), then sell what Dhan still holds (J-1). */
  async exit(runner: EngineRunner, reason = 'MANUAL EXIT') {
    const p = runner.state.position;
    if (!p) throw new Error('No open position');
    if (!p.live) return runner.manualExit({ reason });
    if (this.busy) throw new Error('Another live order is in progress');
    this.busy = true;
    try {
      const c = ctxOf(runner.config);
      const r = await this.closeAtBroker(runner, p.live.securityId, p.live.slOrderId, p.remainingQty, p.live.slTrigger ?? p.currentSl, p.side ?? 1, c, 'EXIT');
      if (r.kind === 'STOP_FILLED') return runner.manualExit({ price: r.price, reason: 'SL HIT (exchange stop order)' });
      if (r.kind === 'SOLD') return runner.manualExit({ price: r.price, reason: `${reason} (live fill)` });
      if (r.kind === 'FLAT') return this.closedOutside(runner, p, r.price);
      if (r.kind === 'FAILED' && r.stop) await runner.patchPosition({ live: { ...p.live, slOrderId: r.stop.id, slTrigger: r.stop.trigger, slQty: r.stop.qty } });
      throw new Error(runner.status.replace(/^Live order error - /, '') || 'Exit not completed');
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
    // LIVE automatic entry: this cycle confirmed a new signal and the switch is on.
    const auto = runner.takeAutoRequest();
    if (auto && !this.busy) {
      const cfg = runner.config;
      if (cfg.tradeMode === 'LIVE' && cfg.autoEntryLive && !runner.state.position && !runner.state.pendingEntry) {
        try {
          // Same path as tapping ENTER at market: every gate (time cutoff, daily limits, premium
          // filters, lot cap, capital) is checked again, and the exchange stop-loss goes in on fill.
          const pos = await this.enter(runner, undefined, { auto: true });
          if (pos) runner.status = `Automatic LIVE entry filled: ${pos.remainingQty} @ ${pos.entry.toFixed(2)}`;
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
    const sid = live.securityId;
    this.busy = true;
    try {
      if (!after.position) {
        // Engine closed it (SL / T2 / trailing SL / single-lot T1): make it real at Dhan safely (J-1).
        const r = await this.closeAtBroker(runner, sid, live.slOrderId, prev.remainingQty, live.slTrigger ?? prev.currentSl, side, c, 'EXIT');
        if (r.kind === 'STOP_FILLED') await runner.amendExit(prev, r.price, 'exchange stop fill');
        else if (r.kind === 'SOLD') await runner.amendExit(prev, r.price, 'live fill');
        else if (r.kind === 'FLAT') {
          if (r.price) await runner.amendExit(prev, r.price, 'Dhan shows no position (closed outside the app)');
          runner.status = `Live order error - ${prev.direction} ${prev.strike}: Dhan already showed no position when the app exited — nothing was sold`;
        }
        return;
      }
      const cur = after.position;
      if (!prev.partialBooked && cur.partialBooked) {
        await this.bookTarget1(runner, prev, cur, side, c);
        return;
      }
      // Still open: compare with Dhan's positions (J-4), then the stop.
      if ((await this.reconcile(runner, cur, side, c)) === 'CLOSED') return;
      const now = runner.state.position;
      if (!now?.live) return;
      const leg = now.live;
      const filled = await this.stopFilled(leg.slOrderId);
      if (filled) {
        this.busy = false;
        await runner.manualExit({ price: filled.avgPrice, reason: 'SL HIT (exchange stop order)' });
        return;
      }
      const have = leg.slTrigger ?? prev.currentSl;
      if (side * (now.currentSl - have) > 1e-9) {
        // Profit lock raised the stop: replace the exchange stop at the new level.
        await this.moveStop(runner, now, have, side, c);
        return;
      }
      if (leg.slOrderId) {
        const o = await this.order(leg.slOrderId).catch(() => null);
        const st = upper(o?.orderStatus);
        if ((st === 'CANCELLED' || st === 'EXPIRED' || st === 'REJECTED') && runner.marketOpen()) {
          // e.g. a DAY stop expired overnight on a carried position — put it back, but only for a
          // position Dhan really holds (J-4).
          const h = await this.held(sid, c, side);
          if (h == null) {
            this.warn(runner, `dead:${leg.slOrderId}`, `The stop-loss order ${leg.slOrderId} is ${st} and Dhan's positions can't be read — protection can't be confirmed; no new stop placed yet (retrying). Check Dhan now.`);
            return;
          }
          if (h.qty <= 0) {
            this.busy = false;
            await this.closedOutside(runner, now, h.row?.sellAvg || null);
            return;
          }
          const trigger = leg.slTrigger ?? now.currentSl;
          const sl = await this.placeStop(sid, h.qty, trigger, side, c);
          await runner.patchPosition({ live: { ...leg, slOrderId: sl, slTrigger: trigger, slQty: h.qty } });
        }
      }
    } catch (e) {
      if (e instanceof Unconfirmed) this.warn(runner, `unconfirmed:${sid}`, e.message);
      else throw e;
    } finally {
      this.busy = false;
    }
  }

  /** Target 1: book half and re-protect the rest — the old stop confirmed cancelled first (J-2). */
  private async bookTarget1(runner: EngineRunner, prev: OpenPosition, cur: OpenPosition, side: 1 | -1, c: OrderCtx) {
    const live = prev.live!;
    const sid = live.securityId;
    let stopSold = 0;
    if (live.slOrderId) {
      const r = await cancelConfirmed(this.book, live.slOrderId, this.sleep);
      if (r.state === 'FILLED') {
        this.busy = false;
        await runner.manualExit({ price: r.avgPrice, reason: 'SL HIT (exchange stop order)' });
        return;
      }
      if (unsure(r)) {
        this.warn(runner, `t1:${live.slOrderId}`, `TARGET 1 booking NOT sent: the stop-loss order ${live.slOrderId} could not be confirmed cancelled (${r.status || 'status unknown'}) — the full quantity stays protected by it. Check Dhan → Orders.`);
        return;
      }
      stopSold = r.filledQty;
    }
    const h = await this.held(sid, c, side);
    const holding = h == null ? prev.remainingQty - stopSold : Math.min(prev.remainingQty - stopSold, h.qty);
    if (!(holding > 0)) {
      this.busy = false;
      if (stopSold > 0) await runner.manualExit({ price: cur.target1, reason: 'SL HIT (exchange stop order)' });
      else await this.closedOutside(runner, cur, h?.row?.sellAvg || null);
      return;
    }
    let sold = 0;
    try {
      sold = (await this.closeOrder(sid, closeSide(side), Math.min(cur.partialQty, holding), c)).filledQty;
    } catch (e) {
      if (e instanceof Unconfirmed) {
        this.warn(runner, `t1:${sid}`, `TARGET 1 booking: ${e.message}. No stop-loss is placed while that order may still fill — check Dhan NOW.`);
        return;
      }
      const st = await this.reprotect(runner, sid, holding - filledOf(e), live.slTrigger ?? prev.currentSl, side, c, 'TARGET 1 booking', e);
      if (st) await runner.patchPosition({ live: { ...live, slOrderId: st.id, slTrigger: st.trigger, slQty: st.qty } });
      return;
    }
    const rest = holding - sold;
    if (!(rest > 0)) {
      await runner.patchPosition({ live: { ...live, slOrderId: null, slTrigger: undefined, slQty: 0 } });
      return;
    }
    try {
      const sl = await this.placeStop(sid, rest, cur.currentSl, side, c);
      await runner.patchPosition({ live: { ...live, slOrderId: sl, slTrigger: cur.currentSl, slQty: rest } });
    } catch (e) {
      if (e instanceof Unconfirmed) throw e;
      const st = await this.reprotect(runner, sid, rest, cur.currentSl, side, c, 'Stop-loss after Target 1', e);
      await runner.patchPosition({ live: { ...live, slOrderId: st?.id ?? null, slTrigger: st?.trigger, slQty: st?.qty ?? 0 } });
    }
  }

  /** Move the exchange stop: old one confirmed cancelled first (J-2); new one covers what Dhan holds. */
  private async moveStop(runner: EngineRunner, cur: OpenPosition, have: number, side: 1 | -1, c: OrderCtx) {
    const live = cur.live!;
    const sid = live.securityId;
    const key = live.entryOrderId;
    if ((this.retryAt.get(key) ?? 0) > Date.now()) return;
    let stopSold = 0;
    if (live.slOrderId) {
      const r = await cancelConfirmed(this.book, live.slOrderId, this.sleep);
      if (r.state === 'FILLED') {
        this.busy = false;
        await runner.manualExit({ price: r.avgPrice, reason: 'SL HIT (exchange stop order)' });
        return;
      }
      if (unsure(r)) {
        this.retryAt.set(key, Date.now() + this.retryMs);
        this.warn(runner, `move:${live.slOrderId}`, `Moving the stop-loss to ${cur.currentSl.toFixed(2)} NOT done: the old stop-loss order ${live.slOrderId} could not be confirmed cancelled (${r.status || 'status unknown'}) — it still protects at ${have.toFixed(2)}; retrying.`);
        return;
      }
      stopSold = r.filledQty;
    }
    const h = await this.held(sid, c, side);
    const qty = h == null ? cur.remainingQty - stopSold : h.qty;
    if (!(qty > 0)) {
      this.busy = false;
      if (stopSold > 0) await runner.manualExit({ price: have, reason: 'SL HIT (exchange stop order)' });
      else await this.closedOutside(runner, cur, h?.row?.sellAvg || null);
      return;
    }
    try {
      const sl = await this.placeStop(sid, qty, cur.currentSl, side, c);
      this.retryAt.delete(key);
      await runner.patchPosition({ live: { ...live, slOrderId: sl, slTrigger: cur.currentSl, slQty: qty } });
    } catch (e) {
      if (e instanceof Unconfirmed) throw e;
      this.retryAt.set(key, Date.now() + this.retryMs);
      const st = await this.reprotect(runner, sid, qty, have, side, c, 'Moving the stop-loss', e);
      await runner.patchPosition({ live: { ...live, slOrderId: st?.id ?? null, slTrigger: st?.trigger ?? have, slQty: st?.qty ?? 0 } });
    }
  }

  /** J-4: compare the open position with Dhan's positions (see v2 liveTrader.reconcile). */
  private async reconcile(runner: EngineRunner, cur: OpenPosition, side: 1 | -1, c: OrderCtx): Promise<'OK' | 'CLOSED'> {
    const live = cur.live!;
    const sid = live.securityId;
    const key = live.entryOrderId;
    const st = this.recon.get(key) ?? { at: 0, zeroAt: null };
    const t = Date.now();
    if (t - st.at < (st.zeroAt != null ? this.flatConfirmMs : this.reconEveryMs)) return 'OK';
    st.at = t;
    this.recon.set(key, st);
    const h = await this.held(sid, c, side);
    if (h == null) return 'OK';
    if (h.qty <= 0) {
      if (await this.stopFilled(live.slOrderId)) return 'OK';
      if (t - (this.openedAt.get(key) ?? 0) < this.freshEntryMs) return 'OK';
      if (st.zeroAt == null) {
        st.zeroAt = t;
        return 'OK';
      }
      if (t - st.zeroAt < this.flatConfirmMs) return 'OK';
      if (live.slOrderId) {
        const r = await cancelConfirmed(this.book, live.slOrderId, this.sleep);
        if (r.state === 'FILLED') {
          this.busy = false;
          await runner.manualExit({ price: r.avgPrice, reason: 'SL HIT (exchange stop order)' });
          return 'CLOSED';
        }
        if (unsure(r)) {
          this.warn(runner, `flat:${live.slOrderId}`, `Dhan shows NO position for ${cur.direction} ${cur.strike}, but the stop-loss order ${live.slOrderId} could not be confirmed cancelled — cancel it in the Dhan app NOW so it can't sell what you don't hold.`);
          return 'OK';
        }
      }
      this.recon.delete(key);
      this.busy = false;
      await this.closedOutside(runner, cur, h.row?.sellAvg || null);
      return 'CLOSED';
    }
    st.zeroAt = null;
    if (h.qty !== cur.remainingQty) {
      this.warn(runner, `qty:${key}`, `Dhan holds ${h.qty} of ${cur.direction} ${cur.strike}; the app expected ${cur.remainingQty} (partial fill or a change outside the app). Orders are limited to what Dhan holds.`);
      const slQty = live.slQty ?? cur.remainingQty;
      if (live.slOrderId && slQty > h.qty) {
        const r = await cancelConfirmed(this.book, live.slOrderId, this.sleep);
        if (r.state === 'FILLED') {
          this.busy = false;
          await runner.manualExit({ price: r.avgPrice, reason: 'SL HIT (exchange stop order)' });
          return 'CLOSED';
        }
        if (unsure(r)) return 'OK';
        const left = Math.max(0, h.qty - r.filledQty);
        const trigger = live.slTrigger ?? cur.currentSl;
        if (!(left > 0)) {
          await runner.patchPosition({ live: { ...live, slOrderId: null, slQty: 0 } });
          return 'OK';
        }
        const sl = await this.placeStop(sid, left, trigger, side, c);
        await runner.patchPosition({ live: { ...live, slOrderId: sl, slTrigger: trigger, slQty: left } });
      }
    }
    return 'OK';
  }
}
