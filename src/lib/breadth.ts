/**
 * Market breadth — advances / declines of the index's own stocks, worked out from broker quotes
 * (nseindia.com doesn't serve apps). Plus the weighted move: heavyweights like HDFC Bank and
 * Reliance move the index far more than the small ones, so "30 up, 20 down" can still be a
 * falling index. Pure: the runner fetches the quotes, this turns them into a read.
 *
 * Weights are approximate (NSE rebalances twice a year); they only decide how much each stock counts.
 */
import { splitCsvLine } from '../../server/scripMaster.ts';

export interface BreadthStock {
  symbol: string;
  /** Approximate index weight (%). */
  weight: number;
  /** NSE token (= Dhan NSE_EQ security id = Angel One NSE token) when known without the instrument list. */
  id?: string;
}

/** NIFTY 50 (approx. weights). Symbols the instrument list doesn't know (renamed / dropped) are skipped. */
export const NIFTY50_STOCKS: BreadthStock[] = [
  { symbol: 'HDFCBANK', weight: 13, id: '1333' },
  { symbol: 'ICICIBANK', weight: 9, id: '4963' },
  { symbol: 'RELIANCE', weight: 8.5, id: '2885' },
  { symbol: 'INFY', weight: 5, id: '1594' },
  { symbol: 'BHARTIARTL', weight: 4.7, id: '10604' },
  { symbol: 'LT', weight: 3.8, id: '11483' },
  { symbol: 'ITC', weight: 3.4, id: '1660' },
  { symbol: 'TCS', weight: 3, id: '11536' },
  { symbol: 'SBIN', weight: 3, id: '3045' },
  { symbol: 'AXISBANK', weight: 3, id: '5900' },
  { symbol: 'KOTAKBANK', weight: 2.7, id: '1922' },
  { symbol: 'M&M', weight: 2.6 },
  { symbol: 'BAJFINANCE', weight: 2.3, id: '317' },
  { symbol: 'HINDUNILVR', weight: 1.9, id: '1394' },
  { symbol: 'SUNPHARMA', weight: 1.6, id: '3351' },
  { symbol: 'HCLTECH', weight: 1.6 },
  { symbol: 'MARUTI', weight: 1.5, id: '10999' },
  { symbol: 'NTPC', weight: 1.4 },
  { symbol: 'ETERNAL', weight: 1.4 },
  { symbol: 'TITAN', weight: 1.3, id: '3506' },
  { symbol: 'ULTRACEMCO', weight: 1.2 },
  { symbol: 'TMPV', weight: 1 },
  { symbol: 'TATAMOTORS', weight: 1 },
  { symbol: 'POWERGRID', weight: 1.1 },
  { symbol: 'TATASTEEL', weight: 1.1 },
  { symbol: 'BEL', weight: 1.1 },
  { symbol: 'TRENT', weight: 1 },
  { symbol: 'BAJAJFINSV', weight: 1 },
  { symbol: 'ASIANPAINT', weight: 1 },
  { symbol: 'JSWSTEEL', weight: 0.9 },
  { symbol: 'ADANIPORTS', weight: 0.9 },
  { symbol: 'TECHM', weight: 0.9 },
  { symbol: 'HINDALCO', weight: 0.9 },
  { symbol: 'ONGC', weight: 0.9 },
  { symbol: 'GRASIM', weight: 0.9 },
  { symbol: 'COALINDIA', weight: 0.8 },
  { symbol: 'SHRIRAMFIN', weight: 0.8 },
  { symbol: 'BAJAJ-AUTO', weight: 0.8 },
  { symbol: 'JIOFIN', weight: 0.8 },
  { symbol: 'NESTLEIND', weight: 0.7 },
  { symbol: 'EICHERMOT', weight: 0.7 },
  { symbol: 'CIPLA', weight: 0.7 },
  { symbol: 'SBILIFE', weight: 0.7 },
  { symbol: 'HDFCLIFE', weight: 0.7 },
  { symbol: 'WIPRO', weight: 0.6 },
  { symbol: 'ADANIENT', weight: 0.6 },
  { symbol: 'TATACONSUM', weight: 0.6 },
  { symbol: 'DRREDDY', weight: 0.6 },
  { symbol: 'APOLLOHOSP', weight: 0.6 },
  { symbol: 'MAXHEALTH', weight: 0.6 },
  { symbol: 'INDIGO', weight: 0.6 },
  { symbol: 'INDUSINDBK', weight: 0.5 },
  { symbol: 'HEROMOTOCO', weight: 0.5 },
  { symbol: 'BRITANNIA', weight: 0.5 },
];

/** BANK NIFTY (approx. weights). */
export const BANKNIFTY_STOCKS: BreadthStock[] = [
  { symbol: 'HDFCBANK', weight: 28, id: '1333' },
  { symbol: 'ICICIBANK', weight: 25, id: '4963' },
  { symbol: 'SBIN', weight: 9, id: '3045' },
  { symbol: 'KOTAKBANK', weight: 8, id: '1922' },
  { symbol: 'AXISBANK', weight: 8, id: '5900' },
  { symbol: 'INDUSINDBK', weight: 3 },
  { symbol: 'BANKBARODA', weight: 3 },
  { symbol: 'FEDERALBNK', weight: 3 },
  { symbol: 'AUBANK', weight: 3 },
  { symbol: 'IDFCFIRSTB', weight: 3 },
  { symbol: 'PNB', weight: 3 },
  { symbol: 'CANBK', weight: 3 },
];

/** Which basket an index is read against (FIN NIFTY and the rest: the NIFTY 50). */
export const breadthGroup = (symbol: string): 'NIFTY' | 'BANKNIFTY' => (symbol === 'BANKNIFTY' ? 'BANKNIFTY' : 'NIFTY');
export const groupStocks = (g: 'NIFTY' | 'BANKNIFTY') => (g === 'BANKNIFTY' ? BANKNIFTY_STOCKS : NIFTY50_STOCKS);
export const groupLabel = (g: 'NIFTY' | 'BANKNIFTY') => (g === 'BANKNIFTY' ? 'Bank Nifty stocks' : 'Nifty 50 stocks');

export interface StockQuote {
  symbol: string;
  ltp: number;
  prevClose: number;
}

export type BreadthLevel = 'STRONG UP' | 'UP' | 'MIXED' | 'DOWN' | 'STRONG DOWN';

export interface Mover {
  symbol: string;
  pct: number;
  /** Points of the weighted move it gives (weight × % / total weight). */
  contrib: number;
}

export interface Breadth {
  group: 'NIFTY' | 'BANKNIFTY';
  at: number;
  advances: number;
  declines: number;
  unchanged: number;
  /** Stocks priced / in the basket. */
  counted: number;
  total: number;
  /** Advances as a share of advances + declines (0–100). */
  advPct: number;
  /** Weighted average move (%), close to the index's own move. */
  weightedPct: number;
  level: BreadthLevel;
  /** Index up on a few heavyweights while most stocks fall (or the reverse). */
  narrow: boolean;
  up: Mover[];
  down: Mover[];
  /** "Nifty 50 stocks: 38 up, 12 down · weighted +0.42%". */
  text: string;
}

const sign = (n: number) => (n >= 0 ? '+' : '−');
const pctTxt = (n: number) => `${sign(n)}${Math.abs(n).toFixed(2)}%`;

export function computeBreadth(group: 'NIFTY' | 'BANKNIFTY', quotes: StockQuote[], at: number): Breadth | null {
  const stocks = groupStocks(group);
  const w = new Map(stocks.map((s) => [s.symbol, s.weight]));
  const rows = quotes
    .filter((q) => w.has(q.symbol) && q.ltp > 0 && q.prevClose > 0)
    .map((q) => ({ symbol: q.symbol, pct: (100 * (q.ltp - q.prevClose)) / q.prevClose, w: w.get(q.symbol)! }));
  if (rows.length < Math.min(5, stocks.length)) return null;
  const eps = 0.005;
  const advances = rows.filter((r) => r.pct > eps).length;
  const declines = rows.filter((r) => r.pct < -eps).length;
  const unchanged = rows.length - advances - declines;
  const tw = rows.reduce((s, r) => s + r.w, 0);
  const weightedPct = rows.reduce((s, r) => s + r.w * r.pct, 0) / tw;
  const advPct = advances + declines ? (100 * advances) / (advances + declines) : 50;
  const level: BreadthLevel =
    advPct >= 75 && weightedPct > 0
      ? 'STRONG UP'
      : advPct <= 25 && weightedPct < 0
        ? 'STRONG DOWN'
        : advPct >= 60 && weightedPct > -0.05
          ? 'UP'
          : advPct <= 40 && weightedPct < 0.05
            ? 'DOWN'
            : 'MIXED';
  const narrow = (weightedPct > 0.15 && advPct < 40) || (weightedPct < -0.15 && advPct > 60);
  const movers = rows.map((r) => ({ symbol: r.symbol, pct: r.pct, contrib: (r.w * r.pct) / tw }));
  const up = movers.filter((m) => m.contrib > 0).sort((a, b) => b.contrib - a.contrib).slice(0, 3);
  const down = movers.filter((m) => m.contrib < 0).sort((a, b) => a.contrib - b.contrib).slice(0, 3);
  const of = rows.length < stocks.length ? ` (${rows.length} of ${stocks.length} priced)` : '';
  const text = `${groupLabel(group)}: ${advances} up, ${declines} down · weighted ${pctTxt(weightedPct)}${narrow ? ' · narrow: a few heavyweights carry it' : ''}${of}`;
  return { group, at, advances, declines, unchanged, counted: rows.length, total: stocks.length, advPct, weightedPct, level, narrow, up, down, text };
}

/** How breadth sits with a trade side: with it, against it (strongly = skip), or no view. */
export function breadthFit(b: Breadth | null | undefined, side: 'up' | 'down'): { fit: 'WITH' | 'AGAINST' | 'STRONG AGAINST' | 'NEUTRAL'; words: string } {
  if (!b) return { fit: 'NEUTRAL', words: '' };
  const words = `breadth ${b.advances} up ${b.declines} down`;
  const upish = b.level === 'UP' || b.level === 'STRONG UP';
  const downish = b.level === 'DOWN' || b.level === 'STRONG DOWN';
  if (side === 'up') {
    if (b.level === 'STRONG DOWN') return { fit: 'STRONG AGAINST', words };
    if (downish || (b.narrow && b.weightedPct > 0)) return { fit: 'AGAINST', words };
    return { fit: upish ? 'WITH' : 'NEUTRAL', words };
  }
  if (b.level === 'STRONG UP') return { fit: 'STRONG AGAINST', words };
  if (upish || (b.narrow && b.weightedPct < 0)) return { fit: 'AGAINST', words };
  return { fit: downish ? 'WITH' : 'NEUTRAL', words };
}

// ---- Stock ids from the broker's instrument list ------------------------------------------------


/**
 * Symbol → NSE token from Dhan's NSE equity list (the detailed segment CSV or the compact master):
 * EQ-series equities only. Columns found by name.
 */
export function parseEquityIds(csv: string, symbols: Set<string>): Map<string, string> {
  const lines = csv.split(/\r?\n/);
  const header = splitCsvLine(lines[0] ?? '').map((h) => h.trim().toUpperCase());
  const col = (names: string[]) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
  const ID = col(['SECURITY_ID', 'SEM_SMST_SECURITY_ID']);
  const EXCH = col(['EXCH_ID', 'SEM_EXM_EXCH_ID']);
  const INSTR = col(['INSTRUMENT', 'SEM_INSTRUMENT_NAME']);
  const SERIES = col(['SERIES', 'SEM_SERIES']);
  const SYMS = [col(['UNDERLYING_SYMBOL']), col(['SEM_TRADING_SYMBOL']), col(['SYMBOL_NAME'])].filter((i) => i >= 0);
  const out = new Map<string, string>();
  if (ID < 0 || !SYMS.length) return out;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const f = splitCsvLine(line);
    if (EXCH >= 0 && f[EXCH] !== 'NSE') continue;
    if (INSTR >= 0 && f[INSTR] !== 'EQUITY') continue;
    if (SERIES >= 0 && f[SERIES] && f[SERIES] !== 'EQ') continue;
    const sym = SYMS.map((c) => (f[c] ?? '').trim().toUpperCase()).find((s) => symbols.has(s));
    if (sym && !out.has(sym) && /^\d+$/.test(f[ID] ?? '')) out.set(sym, f[ID]);
  }
  return out;
}

/** The ids built in (the heavyweights), when the instrument list can't be loaded. */
export function builtInIds(): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of [...NIFTY50_STOCKS, ...BANKNIFTY_STOCKS]) if (s.id) m.set(s.symbol, s.id);
  return m;
}
