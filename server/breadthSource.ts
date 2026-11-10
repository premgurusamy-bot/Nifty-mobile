/**
 * Quotes of the index's stocks for market breadth (advances / declines): one Dhan quote call for
 * the whole basket, Angel One (FULL quotes, 50 a call) when Dhan fails and Angel is logged in.
 * Stock ids come from Dhan's NSE equity list once a day; without it, the built-in heavyweights.
 * No Node-only imports (runs in the app).
 */
import { builtInIds, groupStocks, parseEquityIds, type StockQuote } from '../src/lib/breadth.ts';
import type { AngelClient } from './angel.ts';
import type { DhanClient } from './dhan.ts';

export type BreadthFeed = (group: 'NIFTY' | 'BANKNIFTY') => Promise<StockQuote[]>;

const num = (v: unknown) => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
};

export function breadthFeed(dhan: DhanClient, angel?: AngelClient | null, opts: { now?: () => number; fetchCsv?: () => Promise<string> } = {}): BreadthFeed {
  const now = opts.now ?? Date.now;
  const fetchCsv = opts.fetchCsv ?? (() => dhan.instrumentCsv('NSE_EQ'));
  let ids: { map: Map<string, string>; day: string; full: boolean; triedAt: number } | null = null;
  const day = () => new Date(now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const allSymbols = () => new Set(groupStocks('NIFTY').concat(groupStocks('BANKNIFTY')).map((s) => s.symbol));

  async function idMap(): Promise<Map<string, string>> {
    const d = day();
    // The full list once a day; after a failed download, the built-in ids and another try in 30 min.
    if (ids && ids.day === d && (ids.full || now() - ids.triedAt < 30 * 60_000)) return ids.map;
    try {
      const parsed = parseEquityIds(await fetchCsv(), allSymbols());
      if (parsed.size < 10) throw new Error('equity list incomplete');
      // A symbol the list misses keeps its built-in id.
      for (const [s, id] of builtInIds()) if (!parsed.has(s)) parsed.set(s, id);
      ids = { map: parsed, day: d, full: true, triedAt: now() };
    } catch {
      ids = { map: builtInIds(), day: d, full: false, triedAt: now() };
    }
    return ids.map;
  }

  return async (group) => {
    const map = await idMap();
    const basket = groupStocks(group)
      .map((s) => ({ symbol: s.symbol, id: map.get(s.symbol) }))
      .filter((s): s is { symbol: string; id: string } => !!s.id);
    if (!basket.length) throw new Error('No stock ids for market breadth');
    try {
      const q = await dhan.quote({ NSE_EQ: basket.map((s) => Number(s.id)) });
      const out: StockQuote[] = [];
      for (const s of basket) {
        const r = q?.data?.NSE_EQ?.[s.id];
        const ltp = num(r?.last_price);
        if (!(ltp > 0)) continue;
        // During the session ohlc.close is the previous close; net_change is ltp − previous close.
        const prevClose = r?.net_change != null ? ltp - num(r.net_change) : num(r?.ohlc?.close);
        if (prevClose > 0) out.push({ symbol: s.symbol, ltp, prevClose });
      }
      if (out.length) return out;
      throw new Error('Dhan returned no stock quotes');
    } catch (e) {
      if (!angel?.connected) throw e;
      const out: StockQuote[] = [];
      const bySym = new Map(basket.map((s) => [s.id, s.symbol]));
      for (let i = 0; i < basket.length; i += 50) {
        const part = basket.slice(i, i + 50).map((s) => s.id);
        for (const r of await angel.quote('FULL', { NSE: part })) {
          const sym = bySym.get(String(r.symbolToken ?? r.symboltoken));
          const ltp = num(r.ltp);
          const prevClose = num(r.close) || (r.netChange != null ? ltp - num(r.netChange) : 0);
          if (sym && ltp > 0 && prevClose > 0) out.push({ symbol: sym, ltp, prevClose });
        }
      }
      return out;
    }
  };
}
