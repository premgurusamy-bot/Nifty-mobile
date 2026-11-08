/**
 * Fast ticks: between the full refreshes (candles + option chain, which Dhan allows once per 3 s),
 * one Dhan quote call per second refreshes the prices the engine acts on:
 *  - each index's spot (MCX: the future's price) — it updates the forming 5-min candle, so a setup's
 *    break is seen within about a second;
 *  - the premiums of the open trade, the armed setup, a pending limit entry and the strikes around
 *    the money — so stops, Target 1, the loss trail / profit lock and entry prices use fresh prices.
 * OI, IV and Greeks stay from the last option chain until the next full refresh.
 */
import { findStrike } from './indicators.ts';
import type { Candle, ChainSnapshot, ChainStrike, EngineConfig, Leg, SymbolState } from './types.ts';

export interface QuoteReq {
  segment: string;
  securityId: string;
}
/** Latest prices by `${segment}|${securityId}`. */
export type QuoteMap = Record<string, number>;
export type QuoteSource = (reqs: QuoteReq[]) => Promise<QuoteMap>;

export const quoteKey = (r: QuoteReq) => `${r.segment}|${r.securityId}`;
const CANDLE_MS = 5 * 60_000;

type Data = { candles: Candle[]; chain: ChainSnapshot };
type Side = 'ce' | 'pe';
const sideOf = (d: string): Side | null => (d === 'CE' ? 'ce' : d === 'PE' ? 'pe' : null);

/** What the spot / future price is quoted as. */
function spotReq(cfg: EngineConfig): QuoteReq | null {
  if (cfg.instrumentKind === 'MCX_FUTURES')
    return cfg.futSecurityId ? { segment: cfg.tradeSegment || 'MCX_COMM', securityId: String(cfg.futSecurityId) } : null;
  return cfg.underlyingSecurityId ? { segment: cfg.underlyingSegment, securityId: String(cfg.underlyingSecurityId) } : null;
}

/** Option legs worth quoting: the trade, the setup, a pending entry, and ATM ± 1 strike (both sides). */
function legsOf(data: Data, st: Partial<SymbolState>): { row: ChainStrike; side: Side; id?: string }[] {
  const chain = data.chain;
  if (!chain.strikes.length) return [];
  const out: { row: ChainStrike; side: Side; id?: string }[] = [];
  const add = (strike: number, dir: string, id?: string) => {
    const side = sideOf(dir);
    const row = findStrike(chain, strike);
    if (side && row) out.push({ row, side, id });
  };
  const p = st.position;
  if (p) add(p.strike, p.direction, p.live?.securityId);
  if (st.pending) add(st.pending.strike, st.pending.direction);
  if (st.pendingEntry) add(st.pendingEntry.plan.strike, st.pendingEntry.plan.direction, st.pendingEntry.live?.securityId);
  const atm = findStrike(chain, chain.spot);
  if (atm) {
    const i = chain.strikes.indexOf(atm);
    for (const row of chain.strikes.slice(Math.max(0, i - 1), i + 2)) {
      out.push({ row, side: 'ce' }, { row, side: 'pe' });
    }
  }
  return out;
}

const legId = (l: { row: ChainStrike; side: Side; id?: string }) => l.id ?? l.row[l.side]?.securityId;

/** The quotes one index needs this second. */
export function tickRequests(cfg: EngineConfig, data: Data, st: Partial<SymbolState>): QuoteReq[] {
  const reqs: QuoteReq[] = [];
  const s = spotReq(cfg);
  if (s) reqs.push(s);
  for (const l of legsOf(data, st)) {
    const id = legId(l);
    if (id) reqs.push({ segment: cfg.tradeSegment || 'NSE_FNO', securityId: String(id) });
  }
  const seen = new Set<string>();
  return reqs.filter((r) => !seen.has(quoteKey(r)) && !!seen.add(quoteKey(r)));
}

/** The forming 5-min candle with the new price in it (a new candle when a new 5 minutes began). */
export function tickCandles(candles: Candle[], price: number, now: number): Candle[] {
  const last = candles[candles.length - 1];
  if (!last || !(price > 0)) return candles;
  const bucket = Math.floor(now / CANDLE_MS) * CANDLE_MS;
  if (last.t < bucket) return [...candles, { t: bucket, o: price, h: price, l: price, c: price, v: 0 }];
  return [...candles.slice(0, -1), { ...last, h: Math.max(last.h, price), l: Math.min(last.l, price), c: price }];
}

/** One index's data with this second's quotes applied (unchanged where nothing was quoted). */
export function applyTick(cfg: EngineConfig, data: Data, st: Partial<SymbolState>, quotes: QuoteMap, now: number): Data {
  const s = spotReq(cfg);
  const spot = s ? quotes[quoteKey(s)] : undefined;
  const seg = cfg.tradeSegment || 'NSE_FNO';
  const patch = new Map<ChainStrike, Partial<Record<Side, number>>>();
  for (const l of legsOf(data, st)) {
    const id = legId(l);
    const ltp = id ? quotes[`${seg}|${id}`] : undefined;
    if (ltp != null && ltp > 0) patch.set(l.row, { ...(patch.get(l.row) ?? {}), [l.side]: ltp });
  }
  const strikes = patch.size
    ? data.chain.strikes.map((row) => {
        const p = patch.get(row);
        if (!p) return row;
        const leg = (side: Side): Leg | null => (row[side] && p[side] ? { ...row[side]!, ltp: p[side]! } : row[side]);
        return { ...row, ce: leg('ce'), pe: leg('pe') };
      })
    : data.chain.strikes;
  return {
    candles: spot ? tickCandles(data.candles, spot, now) : data.candles,
    chain: { ...data.chain, spot: spot && spot > 0 ? spot : data.chain.spot, strikes },
  };
}
