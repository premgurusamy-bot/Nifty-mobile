/// <reference types="node" />
/**
 * Pure mappers from DhanHQ v2 response payloads to the app's types.
 * Parsing is defensive: missing fields become 0/undefined instead of throwing.
 */
import type { PositionRow, Product } from '../src/lib/apiTypes.ts';
import { externalId, kindOf, optionId, parseExternalId, parseOptionId } from '../src/lib/instruments.ts';
import type { ChainRow } from '../src/lib/optionChain.ts';
import type { Candle, ChainSnapshot, ChainStrike, Leg } from '../src/lib/engine/types.ts';
import type { Order, OrderStatus } from '../src/lib/portfolio.ts';
import type { Quote } from '../src/lib/simulator.ts';
import { istToEpoch } from '../src/lib/time.ts';

const num = (v: unknown, d = 0) => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : d;
};

export interface InstrumentRef {
  segment: string;
  securityId: string;
}

/** Resolves app ids <-> Dhan (segment, securityId). */
export interface Resolver {
  toDhan(id: string): InstrumentRef | null;
  /** Map a Dhan record back to an app id. */
  fromDhan(rec: {
    exchangeSegment?: string;
    securityId?: string | number;
    tradingSymbol?: string;
    drvExpiryDate?: string;
    drvOptionType?: string;
    drvStrikePrice?: number | string;
  }): string;
}

// ---- Market quote --------------------------------------------------------

/** /marketfeed/quote → Quote[] for the requested ids. */
export function mapQuotes(json: any, wanted: { id: string; ref: InstrumentRef }[]): Quote[] {
  const data = json?.data ?? {};
  const out: Quote[] = [];
  for (const { id, ref } of wanted) {
    const q = data?.[ref.segment]?.[ref.securityId];
    if (!q) continue;
    const ltp = num(q.last_price);
    if (!ltp) continue;
    const ohlc = q.ohlc ?? {};
    // During the session ohlc.close is the previous close; net_change is ltp - prevClose.
    const prevClose = q.net_change != null ? ltp - num(q.net_change) : num(ohlc.close, ltp);
    out.push({
      id,
      ltp,
      open: num(ohlc.open, ltp) || ltp,
      high: num(ohlc.high, ltp) || ltp,
      low: num(ohlc.low, ltp) || ltp,
      prevClose: prevClose || ltp,
    });
  }
  return out;
}

// ---- Intraday chart ------------------------------------------------------

/** /charts/intraday → closes for the most recent session only. */
export function mapIntraday(json: any): number[] {
  const closes: unknown[] = json?.close ?? json?.data?.close ?? [];
  const ts: unknown[] = json?.timestamp ?? json?.data?.timestamp ?? [];
  if (!closes.length) return [];
  if (ts.length !== closes.length) return closes.map((c) => num(c));
  const dayOf = (t: unknown) => new Date(num(t) * 1000 + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const lastDay = dayOf(ts[ts.length - 1]);
  const out: number[] = [];
  for (let i = 0; i < closes.length; i++) if (dayOf(ts[i]) === lastDay) out.push(num(closes[i]));
  return out;
}

// ---- Option chain --------------------------------------------------------

/**
 * /optionchain → rows around ATM. Dhan returns `oc` keyed by strike strings like
 * "25650.000000", each with `ce`/`pe` objects (last_price, implied_volatility in %,
 * greeks.delta, oi, security_id).
 */
export function mapOptionChain(
  json: any,
  expiry: string,
  width = 10,
): { spot: number; rows: ChainRow[]; securityIds: Map<string, string> } {
  const data = json?.data ?? {};
  const spot = num(data.last_price);
  const oc = data.oc ?? {};
  const securityIds = new Map<string, string>();
  const strikes = Object.keys(oc)
    .map((k) => ({ key: k, strike: Math.round(num(k)) }))
    .filter((s) => s.strike > 0)
    .sort((a, b) => a.strike - b.strike);
  if (!strikes.length) return { spot, rows: [], securityIds };

  let atmIdx = 0;
  for (let i = 0; i < strikes.length; i++) {
    if (Math.abs(strikes[i].strike - spot) < Math.abs(strikes[atmIdx].strike - spot)) atmIdx = i;
  }
  const from = Math.max(0, atmIdx - width);
  const to = Math.min(strikes.length, atmIdx + width + 1);

  const leg = (raw: any, strike: number, type: 'CE' | 'PE') => {
    const id = optionId({ underlying: 'NIFTY', expiry, strike, type });
    if (raw?.security_id != null) securityIds.set(id, String(raw.security_id));
    return {
      id,
      ltp: num(raw?.last_price),
      delta: num(raw?.greeks?.delta),
      iv: num(raw?.implied_volatility) / 100,
      oi: raw?.oi != null ? num(raw.oi) : undefined,
    };
  };

  const rows: ChainRow[] = [];
  for (const { key, strike } of strikes.slice(from, to)) {
    const r = oc[key] ?? {};
    rows.push({ strike, ce: leg(r.ce, strike, 'CE'), pe: leg(r.pe, strike, 'PE') });
  }
  return { spot, rows, securityIds };
}

export function mapExpiries(json: any): string[] {
  const list: unknown[] = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  return list.map(String).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
}

// ---- Orders --------------------------------------------------------------

export function mapOrderStatus(s: string | undefined): OrderStatus {
  switch ((s ?? '').toUpperCase()) {
    case 'TRADED':
      return 'FILLED';
    case 'CANCELLED':
    case 'EXPIRED':
      return 'CANCELLED';
    case 'REJECTED':
      return 'REJECTED';
    default:
      return 'OPEN'; // TRANSIT, PENDING, PART_TRADED, TRIGGERED
  }
}

/** Dhan timestamps are IST "YYYY-MM-DD HH:MM:SS". */
export function parseIstTimestamp(s: unknown): number {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):?(\d{2})?/.exec(String(s ?? ''));
  if (!m) return Date.now();
  return istToEpoch(m[1], Number(m[2]), Number(m[3])) + Number(m[4] ?? 0) * 1000;
}

export function mapOrder(o: any, resolver: Resolver): Order {
  const status = mapOrderStatus(o.orderStatus);
  const type = String(o.orderType).toUpperCase() === 'LIMIT' ? 'LIMIT' : 'MARKET';
  const avg = num(o.averageTradedPrice);
  return {
    id: String(o.orderId),
    instrumentId: resolver.fromDhan(o),
    side: String(o.transactionType).toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
    qty: num(o.quantity),
    type,
    limitPrice: type === 'LIMIT' ? num(o.price) : undefined,
    status,
    fillPrice: avg > 0 ? avg : undefined,
    reason: status === 'REJECTED' ? o.omsErrorDescription || undefined : undefined,
    createdAt: parseIstTimestamp(o.createTime),
    updatedAt: parseIstTimestamp(o.updateTime ?? o.createTime),
  };
}

// ---- Portfolio -----------------------------------------------------------

export function mapFunds(json: any): number {
  // Dhan's field is spelled "availabelBalance" in v2; accept the corrected spelling too.
  return num(json?.availabelBalance ?? json?.availableBalance ?? json?.data?.availabelBalance);
}

export function mapPositions(list: any, resolver: Resolver): { rows: PositionRow[]; realized: number } {
  const rows: PositionRow[] = [];
  let realized = 0;
  for (const p of Array.isArray(list) ? list : []) {
    realized += num(p.realizedProfit);
    const qty = num(p.netQty);
    if (!qty) continue;
    const id = resolver.fromDhan(p);
    const avg = qty > 0 ? num(p.buyAvg) || num(p.costPrice) : num(p.sellAvg) || num(p.costPrice);
    rows.push({
      key: `${id}|${p.productType ?? ''}`,
      instrumentId: id,
      qty,
      avgPrice: avg,
      tag: p.productType,
      realized: num(p.realizedProfit),
      unrealized: num(p.unrealizedProfit),
    });
  }
  return { rows, realized };
}

export function mapHoldings(list: any, resolver: Resolver): PositionRow[] {
  const rows: PositionRow[] = [];
  for (const h of Array.isArray(list) ? list : []) {
    const qty = num(h.totalQty) || num(h.availableQty);
    if (!qty) continue;
    const id = resolver.fromDhan({
      exchangeSegment: `${h.exchange ?? 'NSE'}_EQ`,
      securityId: h.securityId,
      tradingSymbol: h.tradingSymbol,
    });
    rows.push({ key: `${id}|HOLDING`, instrumentId: id, qty, avgPrice: num(h.avgCostPrice), tag: 'HOLDING' });
  }
  return rows;
}

// ---- Order placement -----------------------------------------------------

export function dhanProductType(instrumentId: string, product: Product): string {
  if (product === 'INTRADAY') return 'INTRADAY';
  // Carry-forward: equities settle to demat (CNC); F&O uses MARGIN (NRML).
  const k = kindOf(instrumentId);
  if (k === 'OPTION') return 'MARGIN';
  if (k === 'EXTERNAL') return parseExternalId(instrumentId)?.segment.endsWith('_FNO') ? 'MARGIN' : 'CNC';
  return 'CNC';
}

export const roundToTick = (p: number) => Math.round(p * 20) / 20;

/** Build an app id from Dhan derivative fields, for NIFTY options only. */
export function niftyOptionIdFromDerivative(rec: {
  tradingSymbol?: string;
  drvExpiryDate?: string;
  drvOptionType?: string;
  drvStrikePrice?: number | string;
}): string | null {
  if (!rec.tradingSymbol?.startsWith('NIFTY-') && !rec.tradingSymbol?.startsWith('NIFTY ')) return null;
  const t = String(rec.drvOptionType ?? '').toUpperCase();
  const type = t === 'CALL' || t === 'CE' ? 'CE' : t === 'PUT' || t === 'PE' ? 'PE' : null;
  const expiry = String(rec.drvExpiryDate ?? '').slice(0, 10);
  const strike = Math.round(num(rec.drvStrikePrice));
  if (!type || !/^\d{4}-\d{2}-\d{2}$/.test(expiry) || !strike) return null;
  const id = optionId({ underlying: 'NIFTY', expiry, strike, type });
  return parseOptionId(id) ? id : null;
}

export const fallbackExternalId = (rec: {
  exchangeSegment?: string;
  securityId?: string | number;
  tradingSymbol?: string;
}) =>
  externalId({
    segment: rec.exchangeSegment ?? 'NSE_EQ',
    securityId: String(rec.securityId ?? '0'),
    symbol: rec.tradingSymbol || String(rec.securityId),
  });

// ---- Engine inputs (full chain + 5-min candles) ---------------------------

/** Full /optionchain → engine snapshot, every strike, Greeks included (FetchOptionChain). */
export function mapEngineChain(json: any, expiry: string): ChainSnapshot {
  const data = json?.data ?? {};
  const oc = data.oc ?? {};
  const leg = (raw: any): Leg | null =>
    raw
      ? {
          ltp: num(raw.last_price),
          oi: num(raw.oi),
          prevOi: num(raw.previous_oi),
          volume: num(raw.volume),
          iv: num(raw.implied_volatility),
          delta: num(raw.greeks?.delta),
          gamma: num(raw.greeks?.gamma),
          theta: num(raw.greeks?.theta),
          vega: num(raw.greeks?.vega),
        }
      : null;
  const strikes: ChainStrike[] = Object.keys(oc)
    .map((k) => ({ strike: num(k), ce: leg(oc[k]?.ce), pe: leg(oc[k]?.pe) }))
    .filter((s) => s.strike > 0)
    .sort((a, b) => a.strike - b.strike);
  return { spot: num(data.last_price), expiry, strikes };
}

/** /charts/intraday → candles (FetchIntraday). Timestamps are epoch seconds. */
export function mapCandles(json: any): Candle[] {
  const d = json?.close ? json : (json?.data ?? {});
  const close: unknown[] = d.close ?? [];
  const out: Candle[] = [];
  for (let i = 0; i < close.length; i++) {
    out.push({
      t: d.timestamp ? num(d.timestamp[i]) * 1000 : i,
      o: num(d.open?.[i]),
      h: num(d.high?.[i]),
      l: num(d.low?.[i]),
      c: num(close[i]),
      v: num(d.volume?.[i]),
    });
  }
  return out;
}
