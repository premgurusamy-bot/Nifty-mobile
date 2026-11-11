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
 *  - Order safety (audit fixes J-1, J-2, J-4):
 *    · a cancel is never assumed: the order is read back (orderSafety.cancelConfirmed). No closing
 *      order and no replacement stop goes in while the old stop may still be working (J-2);
 *    · before a closing SELL, the stop is confirmed cancelled (or found filled — then nothing is
 *      sold) and the quantity is capped at what the broker account holds (J-1);
 *    · the broker's positions are read (every 15 s and after a restart): a position closed outside
 *      the app (manual exit, auto square-off) closes the engine trade and its stop is cancelled; a
 *      smaller holding (partial stop fill) resizes the stop; a stop is never placed for a position
 *      that isn't there, and a failed read never counts as "closed" (J-4).
 *
 * No Node-only imports: runs inside the app (phone talks to the brokers directly).
 */
import { validateLimit, type EngineRunner } from '../src/lib/engine/runner.ts';
import { catalogEntry } from '../src/lib/engine/catalog.ts';
import { sideOf, type EngineConfig, type EngineState, type LiveLegs, type OpenPosition, type TradePlan } from '../src/lib/engine/types.ts';
import { brokerLabel, orderBroker } from '../src/lib/engine/sizing.ts';
import { DhanGateway, isRefused, isUnclear, type BrokerName, type Instrument, type OrderGateway, type PlaceArgs } from './brokers.ts';
import type { DhanClient } from './dhan.ts';
import { roundToTick } from './mapping.ts';
import type { DhanService } from './service.ts';
import { cancelConfirmed, heldQty, type CancelOutcome, type PositionRow } from './orderSafety.ts';

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

/** A closing order that didn't (fully) fill and was cancelled: `filled` units did go. */
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

/** Outcome of closing a live position at the broker. */
type CloseResult =
  | { kind: 'STOP_FILLED'; price: number }
  | { kind: 'SOLD'; price: number }
  | { kind: 'FLAT'; price: number | null }
  | { kind: 'BLOCKED' }
  | { kind: 'FAILED'; stop: { id: string; qty: number; trigger: number } | null };

const dead = (r: CancelOutcome) => r.state === 'CANCELLED';
const unsure = (r: CancelOutcome) => r.state === 'ACTIVE' || r.state === 'UNKNOWN';

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
  /** Position check against the broker (J-4): how often (real ms), and how long "flat" must last. */
  reconEveryMs = 15_000;
  flatConfirmMs = 5_000;
  /** A fresh entry may not show in the broker's positions at once: no "flat" verdict this soon (ms). */
  freshEntryMs = 30_000;
  /** After a stop move that couldn't be done, wait this long before trying again (ms). */
  retryMs = 10_000;
  private recon = new Map<string, { at: number; zeroAt: number | null }>();
  private openedAt = new Map<string, number>();
  private retryAt = new Map<string, number>();
  /** Last alert per topic, so a repeating problem alerts once (until it changes). */
  private warned = new Map<string, string>();

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
    const own: BrokerName = orderBroker(cfg);
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
    try {
      return await this.waitFill(gw, id);
    } catch (e) {
      if (!/not filled yet/.test((e as Error).message)) throw e;
      // Never leave a closing order working at the broker while the app puts a stop back: cancel it
      // and confirm what happened to it (J-2) before anything else is sent.
      const r = await cancelConfirmed(gw, id, this.sleep);
      if (r.state === 'FILLED' && r.filledQty >= qty) return { orderId: id, status: 'TRADED', avgPrice: r.avgPrice, filledQty: r.filledQty };
      if (r.state === 'CANCELLED' || r.state === 'FILLED')
        throw new ExitShort(`Order ${id} not filled in time — cancelled (${r.filledQty} of ${qty} filled)`, r.filledQty);
      throw new Unconfirmed(
        `Order ${id} not filled in time and its cancel could not be confirmed (${r.status || 'status unknown'}) — it may still be working: check ${brokerLabel(gw.name)} → Orders`,
      );
    }
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
    // Not filled in the window: cancel and confirm (J-2). Only a confirmed cancel with nothing filled
    // is "no entry" (which may switch broker); an unconfirmed one must never lead to a second order.
    const r = await cancelConfirmed(gw, orderId, this.sleep);
    if (r.filledQty > 0 && !unsure(r)) return { orderId, status: r.status, avgPrice: r.avgPrice, filledQty: r.filledQty };
    if (unsure(r))
      throw new Error(
        `Order ${orderId} not filled in ${seconds} s — its cancel could not be confirmed (${r.status || 'status unknown'}): check ${brokerLabel(gw.name)} → Orders`,
      );
    throw new NoEntry(`Order ${orderId} not filled in ${seconds} s — cancelled, no trade`);
  }

  /**
   * Protective stop for a position of `posSide` (+1 long → SELL stop below; -1 short → BUY stop above).
   * A placement without a reply is looked up in the order book before anything else (J-2): an
   * order that did reach the broker is used, never doubled.
   */
  private async placeStop(gw: OrderGateway, inst: Instrument, qty: number, trigger: number, posSide: 1 | -1, c: OrderCtx): Promise<string> {
    const t = roundToTick(trigger, c.tick);
    const a = this.args(inst, closeSide(posSide), qty, c, 'STOP_LOSS', stopLimitPrice(t, { side: posSide, tick: c.tick, futures: c.futures }), t);
    const t0 = Date.now();
    try {
      return await gw.place(a);
    } catch (e) {
      if (!isUnclear(e)) throw e;
      await this.sleep(1500);
      const found = await gw.findRecent(a, t0);
      if (found) return found;
      if (found === null) throw e;
      throw new Unconfirmed(`${(e as Error).message} — the stop-loss may or may not have been placed: check ${brokerLabel(gw.name)} → Orders`);
    }
  }

  /** What the broker account actually holds of the instrument (J-4); null = couldn't be read. */
  private async held(gw: OrderGateway, inst: Instrument, c: OrderCtx, side: 1 | -1): Promise<{ qty: number; row: PositionRow | null } | null> {
    if (!gw.positions) return null;
    return heldQty(() => gw.positions!(), inst.securityId, c.product, side, this.sleep);
  }

  /** Raise an alert, once per topic until its message changes. */
  private async warn(runner: EngineRunner, topic: string, msg: string) {
    runner.status = `Live order error - ${msg}`;
    if (this.warned.get(topic) === msg) return;
    this.warned.set(topic, msg);
    await runner.alert(msg).catch(() => {});
  }

  /**
   * An exit / T1 / stop-move order failed while no stop is working (callers make sure the old one is
   * confirmed cancelled): put a protective stop back at once — for what the broker really holds — and
   * raise an alert. Returns the new stop, or null.
   */
  private async reprotect(
    runner: EngineRunner,
    gw: OrderGateway,
    inst: Instrument,
    qty: number,
    trigger: number,
    side: 1 | -1,
    c: OrderCtx,
    what: string,
    err: unknown,
  ): Promise<{ id: string; qty: number; trigger: number } | null> {
    const h = await this.held(gw, inst, c, side);
    const q = h ? h.qty : qty;
    const who = brokerLabel(gw.name);
    if (!(q > 0)) {
      await this.warn(runner, `reprotect:${inst.securityId}`, `${what} FAILED at ${who}: ${(err as Error)?.message ?? err} — ${who} shows nothing left open`);
      return null;
    }
    const id = await this.placeStop(gw, inst, q, trigger, side, c).catch(() => null);
    const msg = `${what} FAILED at ${who}: ${(err as Error)?.message ?? err} — ${q} still open at ${who}; ${
      id ? `stop-loss put back at ${trigger.toFixed(2)}` : `NO stop-loss could be placed — exit it in the ${who} app NOW`
    }`;
    runner.status = `Live order error - ${msg}`;
    await runner.alert(msg).catch(() => {});
    return id ? { id, qty: q, trigger } : null;
  }

  /**
   * Close a live position at the broker safely (J-1): confirm the stop-loss is cancelled first — if
   * it already filled, nothing is sold; if it can't be confirmed, nothing is sent — then sell only
   * what the broker account still holds (what the stop sold before its cancel is counted).
   */
  private async closeAtBroker(
    runner: EngineRunner,
    gw: OrderGateway,
    inst: Instrument,
    slOrderId: string | null,
    wantQty: number,
    trigger: number,
    side: 1 | -1,
    c: OrderCtx,
    what: string,
  ): Promise<CloseResult> {
    let stopPart = { qty: 0, price: 0 };
    if (slOrderId) {
      const r = await cancelConfirmed(gw, slOrderId, this.sleep);
      if (r.state === 'FILLED') return { kind: 'STOP_FILLED', price: r.avgPrice };
      if (unsure(r)) {
        await this.warn(
          runner,
          `close:${slOrderId}`,
          `${what} NOT sent: the stop-loss order ${slOrderId} could not be confirmed cancelled (${r.status || 'status unknown'}) — it still protects the position at ${brokerLabel(gw.name)}. Check ${brokerLabel(gw.name)} → Orders.`,
        );
        return { kind: 'BLOCKED' };
      }
      stopPart = { qty: r.filledQty, price: r.avgPrice };
    }
    const h = await this.held(gw, inst, c, side);
    const left = wantQty - stopPart.qty;
    const qty = h == null ? left : Math.min(left, h.qty);
    if (!(qty > 0)) {
      if (stopPart.qty > 0) return { kind: 'STOP_FILLED', price: stopPart.price };
      return { kind: 'FLAT', price: h?.row?.sellAvg || null };
    }
    let fill: Fill;
    try {
      fill = await this.marketOrder(gw, inst, closeSide(side), qty, c);
    } catch (e) {
      if (e instanceof Unconfirmed) {
        await this.warn(runner, `close:${inst.securityId}`, `${what}: ${e.message}. No new stop-loss is placed while that order may still fill.`);
        return { kind: 'BLOCKED' };
      }
      // The old stop is confirmed gone and the exit didn't (fully) go: protect what is still held.
      return { kind: 'FAILED', stop: await this.reprotect(runner, gw, inst, qty - filledOf(e), trigger, side, c, what, e) };
    }
    const tot = stopPart.qty + fill.filledQty;
    return { kind: 'SOLD', price: tot ? (stopPart.qty * stopPart.price + fill.filledQty * fill.avgPrice) / tot : fill.avgPrice };
  }

  /** The broker shows no position: it was closed outside the app (manual exit, auto square-off). */
  private async closedOutside(runner: EngineRunner, p: OpenPosition, price: number | null) {
    const at = price || runner.premium(p.direction, p.strike) || p.currentSl;
    const who = brokerLabel(p.live?.broker);
    await runner.manualExit({ price: at, reason: `CLOSED OUTSIDE THE APP (${who} shows no position — manual exit or auto square-off)` });
    await runner.alert(`${p.direction} ${p.strike}: ${who} shows no open position — closed outside the app (manual exit or auto square-off). The app's trade is closed${price ? ` at ${price.toFixed(2)}` : ' (exit price estimated)'}.`).catch(() => {});
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
    this.openedAt.set(buy.orderId, Date.now());
    try {
      const sl = await this.placeStop(gw, inst, pos.remainingQty, pos.currentSl, pos.side ?? 1, ctxOf(runner.config));
      await runner.patchPosition({ live: { ...live, slOrderId: sl, slTrigger: pos.currentSl, slQty: pos.remainingQty } });
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
      // Confirm the cancel with the broker (J-2): an order that may still be working stays tracked.
      const r = await cancelConfirmed(gw, pe.live.orderId, this.sleep);
      if (unsure(r))
        throw new Error(
          `Cancel of the limit order ${pe.live.orderId} could not be confirmed (${r.status || 'status unknown'}) — it is still tracked; check ${brokerLabel(gw.name)} → Orders`,
        );
      const f: Fill = { orderId: pe.live.orderId, status: r.status, avgPrice: r.avgPrice, filledQty: r.filledQty };
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

  /**
   * Manual EXIT: confirm the stop is cancelled (or found filled), then sell what the broker still
   * holds at market (J-1). Nothing is sold when the stop's fate can't be confirmed.
   */
  async exit(runner: EngineRunner, reason = 'MANUAL EXIT') {
    const p = runner.state.position;
    if (!p) throw new Error('No open position');
    if (!p.live) return runner.manualExit({ reason });
    if (this.busy) throw new Error('Another live order is in progress');
    this.busy = true;
    try {
      const gw = this.gw(p.live.broker);
      const c = ctxOf(runner.config);
      const r = await this.closeAtBroker(runner, gw, instOf(p.live), p.live.slOrderId, p.remainingQty, p.live.slTrigger ?? p.currentSl, p.side ?? 1, c, 'EXIT');
      if (r.kind === 'STOP_FILLED') return runner.manualExit({ price: r.price, reason: 'SL HIT (exchange stop order)' });
      if (r.kind === 'SOLD') return runner.manualExit({ price: r.price, reason: `${reason} (live fill)` });
      if (r.kind === 'FLAT') return this.closedOutside(runner, p, r.price);
      if (r.kind === 'FAILED' && r.stop)
        await runner.patchPosition({ live: { ...p.live, slOrderId: r.stop.id, slTrigger: r.stop.trigger, slQty: r.stop.qty } });
      throw new Error(runner.status.replace(/^Live order error - /, '') || 'Exit not completed');
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
        // Engine closed it (SL / T2 / trailing SL / single-lot T1): make it real at the broker, safely
        // (J-1) — the exchange stop may have fired at the same moment — and journal the real fill.
        const r = await this.closeAtBroker(runner, gw, inst, live.slOrderId, prev.remainingQty, live.slTrigger ?? prev.currentSl, side, c, 'EXIT');
        if (r.kind === 'STOP_FILLED') await runner.amendExit(prev, r.price, 'exchange stop fill');
        else if (r.kind === 'SOLD') await runner.amendExit(prev, r.price, 'live fill');
        else if (r.kind === 'FLAT') {
          if (r.price) await runner.amendExit(prev, r.price, `${brokerLabel(gw.name)} shows no position (closed outside the app)`);
          await runner.alert(`${prev.direction} ${prev.strike}: ${brokerLabel(gw.name)} already showed no position when the app exited — nothing was sold.`).catch(() => {});
        }
        return;
      }
      const cur = after.position;
      if (!prev.partialBooked && cur.partialBooked) {
        await this.bookTarget1(runner, gw, inst, prev, cur, side, c);
        return;
      }
      // Still open: compare with the broker's positions (J-4), then the stop.
      if ((await this.reconcile(runner, gw, inst, cur, side, c)) === 'CLOSED') return;
      const now = runner.state.position;
      if (!now?.live) return;
      const leg = now.live;
      // Did the exchange stop fire while we weren't looking?
      const filled = await this.stopFilled(gw, leg.slOrderId);
      if (filled) {
        this.busy = false;
        await runner.manualExit({ price: filled.avgPrice, reason: 'SL HIT (exchange stop order)' });
        return;
      }
      const have = leg.slTrigger ?? prev.currentSl;
      if (side * (now.currentSl - have) > 1e-9) {
        // Profit lock / loss trail raised the stop: replace the exchange stop at the new level.
        await this.moveStop(runner, gw, inst, now, have, side, c);
        return;
      }
      if (leg.slOrderId) {
        const o = await gw.order(leg.slOrderId).catch(() => null);
        const st = upper(o?.orderStatus);
        if ((st === 'CANCELLED' || st === 'EXPIRED' || st === 'REJECTED') && runner.marketOpen()) {
          // e.g. a DAY stop expired overnight on a carried position — put it back, but only for a
          // position the broker really holds (J-4): never a SELL stop for something that is gone.
          const h = await this.held(gw, inst, c, side);
          if (h == null) {
            await this.warn(runner, `dead:${leg.slOrderId}`, `The stop-loss order ${leg.slOrderId} is ${st} and ${brokerLabel(gw.name)}'s positions can't be read — protection can't be confirmed; no new stop placed yet (retrying). Check ${brokerLabel(gw.name)} now.`);
            return;
          }
          if (h.qty <= 0) {
            this.busy = false;
            await this.closedOutside(runner, now, h.row?.sellAvg || null);
            return;
          }
          const trigger = leg.slTrigger ?? now.currentSl;
          const sl = await this.placeStop(gw, inst, h.qty, trigger, side, c);
          await runner.patchPosition({ live: { ...leg, slOrderId: sl, slTrigger: trigger, slQty: h.qty } });
        }
      }
    } catch (e) {
      if (e instanceof Unconfirmed) await this.warn(runner, `unconfirmed:${live.securityId}`, e.message);
      else throw e;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Target 1: book half at market and re-protect the rest. The old stop must be confirmed cancelled
   * first (J-2); if it already fired, the trade is over; quantities are capped at what the broker holds.
   */
  private async bookTarget1(runner: EngineRunner, gw: OrderGateway, inst: Instrument, prev: OpenPosition, cur: OpenPosition, side: 1 | -1, c: OrderCtx) {
    const live = prev.live!;
    const who = brokerLabel(gw.name);
    let stopSold = 0;
    if (live.slOrderId) {
      const r = await cancelConfirmed(gw, live.slOrderId, this.sleep);
      if (r.state === 'FILLED') {
        this.busy = false;
        await runner.manualExit({ price: r.avgPrice, reason: 'SL HIT (exchange stop order)' });
        return;
      }
      if (unsure(r)) {
        await this.warn(
          runner,
          `t1:${live.slOrderId}`,
          `TARGET 1 booking NOT sent: the stop-loss order ${live.slOrderId} could not be confirmed cancelled (${r.status || 'status unknown'}) — the full quantity stays protected by it. Check ${who} → Orders.`,
        );
        return;
      }
      stopSold = r.filledQty;
    }
    const h = await this.held(gw, inst, c, side);
    const holding = h == null ? prev.remainingQty - stopSold : Math.min(prev.remainingQty - stopSold, h.qty);
    if (!(holding > 0)) {
      this.busy = false;
      if (stopSold > 0) await runner.manualExit({ price: cur.target1, reason: 'SL HIT (exchange stop order)' });
      else await this.closedOutside(runner, cur, h?.row?.sellAvg || null);
      return;
    }
    let sold = 0;
    try {
      sold = (await this.marketOrder(gw, inst, closeSide(side), Math.min(cur.partialQty, holding), c)).filledQty;
    } catch (e) {
      if (e instanceof Unconfirmed) {
        await this.warn(runner, `t1:${inst.securityId}`, `TARGET 1 booking: ${e.message}. No stop-loss is placed while that order may still fill — check ${who} NOW.`);
        return;
      }
      // Half not booked at the broker: protect what is still held at the old stop.
      const st = await this.reprotect(runner, gw, inst, holding - filledOf(e), live.slTrigger ?? prev.currentSl, side, c, 'TARGET 1 booking', e);
      if (st) await runner.patchPosition({ live: { ...live, slOrderId: st.id, slTrigger: st.trigger, slQty: st.qty } });
      return;
    }
    const rest = holding - sold;
    if (!(rest > 0)) {
      await runner.patchPosition({ live: { ...live, slOrderId: null, slTrigger: undefined, slQty: 0 } });
      return;
    }
    try {
      const sl = await this.placeStop(gw, inst, rest, cur.currentSl, side, c);
      await runner.patchPosition({ live: { ...live, slOrderId: sl, slTrigger: cur.currentSl, slQty: rest } });
    } catch (e) {
      if (e instanceof Unconfirmed) throw e;
      const st = await this.reprotect(runner, gw, inst, rest, cur.currentSl, side, c, 'Stop-loss after Target 1', e);
      await runner.patchPosition({ live: { ...live, slOrderId: st?.id ?? null, slTrigger: st?.trigger, slQty: st?.qty ?? 0 } });
    }
  }

  /**
   * Move the exchange stop to `cur.currentSl` (from `have`): cancel and confirm the old one first —
   * never a second stop while it may still work (J-2); if it already fired, the trade is over. The
   * new stop covers what the broker actually holds. A move that can't be done is retried later.
   */
  private async moveStop(runner: EngineRunner, gw: OrderGateway, inst: Instrument, cur: OpenPosition, have: number, side: 1 | -1, c: OrderCtx) {
    const live = cur.live!;
    const key = live.entryOrderId;
    if ((this.retryAt.get(key) ?? 0) > Date.now()) return;
    const who = brokerLabel(gw.name);
    let stopSold = 0;
    if (live.slOrderId) {
      const r = await cancelConfirmed(gw, live.slOrderId, this.sleep);
      if (r.state === 'FILLED') {
        this.busy = false;
        await runner.manualExit({ price: r.avgPrice, reason: 'SL HIT (exchange stop order)' });
        return;
      }
      if (unsure(r)) {
        this.retryAt.set(key, Date.now() + this.retryMs);
        await this.warn(
          runner,
          `move:${live.slOrderId}`,
          `Moving the stop-loss to ${cur.currentSl.toFixed(2)} NOT done: the old stop-loss order ${live.slOrderId} could not be confirmed cancelled (${r.status || 'status unknown'}) — it still protects at ${have.toFixed(2)}; retrying.`,
        );
        return;
      }
      stopSold = r.filledQty;
    }
    const h = await this.held(gw, inst, c, side);
    const qty = h == null ? cur.remainingQty - stopSold : h.qty;
    if (!(qty > 0)) {
      this.busy = false;
      if (stopSold > 0) await runner.manualExit({ price: have, reason: 'SL HIT (exchange stop order)' });
      else await this.closedOutside(runner, cur, h?.row?.sellAvg || null);
      return;
    }
    try {
      const sl = await this.placeStop(gw, inst, qty, cur.currentSl, side, c);
      this.retryAt.delete(key);
      await runner.patchPosition({ live: { ...live, slOrderId: sl, slTrigger: cur.currentSl, slQty: qty } });
    } catch (e) {
      if (e instanceof Unconfirmed) throw e;
      // The raised stop was refused: put one back at the old level rather than none; try the raise again later.
      this.retryAt.set(key, Date.now() + this.retryMs);
      const st = await this.reprotect(runner, gw, inst, qty, have, side, c, 'Moving the stop-loss', e);
      await runner.patchPosition({ live: { ...live, slOrderId: st?.id ?? null, slTrigger: st?.trigger ?? have, slQty: st?.qty ?? 0 } });
    }
  }

  /**
   * J-4: compare the open position with the broker's positions (every reconEveryMs, and at once
   * after a restart). Flat at the broker (seen twice, flatConfirmMs apart, not right after the entry)
   * → closed outside the app: our stop is cancelled (confirmed) so it can't sell a position that is
   * gone, and the engine trade is closed. Holding less than expected (partial stop fill, partial
   * manual exit) → alert, and a stop bigger than the holding is resized down. A failed read changes
   * nothing.
   */
  private async reconcile(runner: EngineRunner, gw: OrderGateway, inst: Instrument, cur: OpenPosition, side: 1 | -1, c: OrderCtx): Promise<'OK' | 'CLOSED'> {
    const live = cur.live!;
    const key = live.entryOrderId;
    const st = this.recon.get(key) ?? { at: 0, zeroAt: null };
    const t = Date.now();
    if (t - st.at < (st.zeroAt != null ? this.flatConfirmMs : this.reconEveryMs)) return 'OK';
    st.at = t;
    this.recon.set(key, st);
    const h = await this.held(gw, inst, c, side);
    if (h == null) return 'OK'; // unknown: never taken as closed
    const who = brokerLabel(gw.name);
    if (h.qty <= 0) {
      if (await this.stopFilled(gw, live.slOrderId)) return 'OK'; // the stop fired: handled as a stop fill
      if (t - (this.openedAt.get(key) ?? 0) < this.freshEntryMs) return 'OK';
      if (st.zeroAt == null) {
        st.zeroAt = t; // look again shortly before deciding
        return 'OK';
      }
      if (t - st.zeroAt < this.flatConfirmMs) return 'OK';
      if (live.slOrderId) {
        const r = await cancelConfirmed(gw, live.slOrderId, this.sleep);
        if (r.state === 'FILLED') {
          this.busy = false;
          await runner.manualExit({ price: r.avgPrice, reason: 'SL HIT (exchange stop order)' });
          return 'CLOSED';
        }
        if (unsure(r)) {
          await this.warn(runner, `flat:${live.slOrderId}`, `${who} shows NO position for ${cur.direction} ${cur.strike}, but the stop-loss order ${live.slOrderId} could not be confirmed cancelled — cancel it in the ${who} app NOW so it can't sell what you don't hold.`);
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
      await this.warn(runner, `qty:${key}`, `${who} holds ${h.qty} of ${cur.direction} ${cur.strike}; the app expected ${cur.remainingQty} (partial fill or a change outside the app). Orders are limited to what ${who} holds.`);
      const slQty = live.slQty ?? cur.remainingQty;
      if (live.slOrderId && slQty > h.qty) {
        // The stop would sell more than is held: resize it down (confirmed cancel first).
        const r = await cancelConfirmed(gw, live.slOrderId, this.sleep);
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
        const sl = await this.placeStop(gw, inst, left, trigger, side, c);
        await runner.patchPosition({ live: { ...live, slOrderId: sl, slTrigger: trigger, slQty: left } });
      }
    }
    return 'OK';
  }
}
