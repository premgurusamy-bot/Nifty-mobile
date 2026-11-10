/**
 * Pre-market report (8:30–9:15 IST): reads yesterday (close, range, trend at the close, pivot levels)
 * and, from 9:00, NSE's pre-open prices (the index's indicative open and its stocks' breadth), then
 * says which side the day leans and the plan for after 9:15. It is a read of the data, not a
 * forecast, and it places no orders: index options have no pre-open session, so trades wait for
 * the engine after 9:15 (and the gap guard after a big gap).
 */
import type { Breadth } from './breadth.ts';
import { istDay } from './engine/indicators.ts';
import { findTrend } from './engine/trend.ts';
import type { Candle } from './engine/types.ts';

export type PreMarketPhase = 'BEFORE' | 'PREOPEN' | 'OPEN';
export type Bias = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface PreMarketInput {
  symbol: string;
  label: string;
  candles: Candle[];
  /** Latest index price (in the pre-open: NSE's indicative open), null if not known. */
  spot: number | null;
  breadth?: Breadth | null;
}

export interface PreMarketItem {
  symbol: string;
  label: string;
  prevClose: number;
  prevHigh: number;
  prevLow: number;
  /** Where yesterday closed in its range (0 = at the low, 100 = at the high). */
  closePos: number;
  /** Yesterday's move (% vs the day before), null with one day of data. */
  dayChangePct: number | null;
  /** Trend at yesterday's close. */
  trendAtClose: 'UP' | 'DOWN' | 'SIDEWAYS' | null;
  pivot: number;
  r1: number;
  s1: number;
  /** Expected open (pre-open price or the stocks' weighted move), null before 9:00. */
  expectedOpen: number | null;
  gapPct: number | null;
  /** Where the gap read came from. */
  gapFrom: 'INDEX' | 'STOCKS' | null;
  bias: Bias;
  /** −4…+4: each sign that agrees counts one. */
  score: number;
  signs: string[];
  plan: string;
}

export interface PreMarketReport {
  phase: PreMarketPhase;
  at: number;
  items: PreMarketItem[];
  headline: string;
  speech: string;
  /** Changes when the read changes (bias / gap side / phase): speak again then. */
  key: string;
}

const istMin = (ms: number) => {
  const d = new Date(ms + 5.5 * 3600_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/** 8:30–9:15 IST on a weekday. */
export function preMarketWindow(ms: number): boolean {
  const wd = new Date(ms + 5.5 * 3600_000).getUTCDay();
  if (wd === 0 || wd === 6) return false;
  const m = istMin(ms);
  return m >= 8 * 60 + 30 && m < 9 * 60 + 15;
}

export const preMarketPhase = (ms: number): PreMarketPhase => {
  const m = istMin(ms);
  return m < 9 * 60 ? 'BEFORE' : m < 9 * 60 + 15 ? 'PREOPEN' : 'OPEN';
};

const r0 = (n: number) => Math.round(n).toLocaleString('en-IN');
const spoken = (label: string) => label.replace(/NIFTY 50/i, 'Nifty').replace(/BANK NIFTY/i, 'Bank Nifty').replace(/FIN NIFTY/i, 'Fin Nifty');

export function preMarketItem(x: PreMarketInput, now: number, opts: { gapGuard: boolean; gapGuardPct: number }): PreMarketItem | null {
  const today = istDay(now);
  const c = x.candles.filter((k) => k.c > 0 && istDay(k.t) < today);
  if (!c.length) return null;
  const lastDay = istDay(c[c.length - 1].t);
  const y = c.filter((k) => istDay(k.t) === lastDay);
  const before = c.filter((k) => istDay(k.t) < lastDay);
  const prevClose = y[y.length - 1].c;
  const prevHigh = Math.max(...y.map((k) => k.h));
  const prevLow = Math.min(...y.map((k) => k.l));
  const range = prevHigh - prevLow || 1;
  const closePos = (100 * (prevClose - prevLow)) / range;
  const dayChangePct = before.length ? (100 * (prevClose - before[before.length - 1].c)) / before[before.length - 1].c : null;
  const t = findTrend(c);
  const trendAtClose = t ? t.direction : null;
  const pivot = (prevHigh + prevLow + prevClose) / 3;
  const r1 = 2 * pivot - prevLow;
  const s1 = 2 * pivot - prevHigh;

  // The gap: NSE's pre-open price for the index once it differs from the close, else the stocks.
  let expectedOpen: number | null = null;
  let gapFrom: PreMarketItem['gapFrom'] = null;
  if (preMarketPhase(now) !== 'BEFORE') {
    // The index's own close (from yesterday's closing prices) differs a little from the last candle's
    // close, so a tiny index "gap" with the stocks clearly moved means the index price isn't updated yet.
    const idxGap = x.spot && x.spot > 0 ? (100 * (x.spot - prevClose)) / prevClose : null;
    const stocksMoved = !!x.breadth && Math.abs(x.breadth.weightedPct) >= 0.05;
    if (idxGap != null && (Math.abs(idxGap) >= 0.05 || !stocksMoved)) {
      expectedOpen = x.spot;
      gapFrom = 'INDEX';
    } else if (x.breadth && Math.abs(x.breadth.weightedPct) > 0.001) {
      expectedOpen = prevClose * (1 + x.breadth.weightedPct / 100);
      gapFrom = 'STOCKS';
    }
  }
  const gapPct = expectedOpen != null ? (100 * (expectedOpen - prevClose)) / prevClose : null;

  const signs: string[] = [];
  let score = 0;
  if (closePos >= 70) {
    score++;
    signs.push('closed near the high');
  } else if (closePos <= 30) {
    score--;
    signs.push('closed near the low');
  }
  if (trendAtClose === 'UP') {
    score++;
    signs.push('up trend at the close');
  } else if (trendAtClose === 'DOWN') {
    score--;
    signs.push('down trend at the close');
  }
  if (gapPct != null && Math.abs(gapPct) >= 0.15) {
    score += gapPct > 0 ? 1 : -1;
    signs.push(`gap ${gapPct > 0 ? 'up' : 'down'} ${Math.abs(gapPct).toFixed(2)}%`);
  }
  const b = preMarketPhase(now) !== 'BEFORE' ? x.breadth : null;
  if (b && (b.level === 'UP' || b.level === 'STRONG UP')) {
    score++;
    signs.push(`pre-open breadth ${b.advances} up ${b.declines} down`);
  } else if (b && (b.level === 'DOWN' || b.level === 'STRONG DOWN')) {
    score--;
    signs.push(`pre-open breadth ${b.advances} up ${b.declines} down`);
  }
  const bias: Bias = score >= 2 ? 'BULLISH' : score <= -2 ? 'BEARISH' : 'NEUTRAL';

  const bigGap = opts.gapGuard && gapPct != null && Math.abs(gapPct) >= opts.gapGuardPct;
  const wait = bigGap ? `Big gap: the gap guard waits until 9:30, then trade the break of the first 15 minutes. ` : '';
  const plan =
    bias === 'BULLISH'
      ? `${wait}Lean CE after 9:15 while price holds above ${r0(Math.min(prevClose, pivot))}; strength above ${r0(prevHigh)}; turns weak below ${r0(s1)}.`
      : bias === 'BEARISH'
        ? `${wait}Lean PE after 9:15 while price stays below ${r0(Math.max(prevClose, pivot))}; weakness below ${r0(prevLow)}; turns strong above ${r0(r1)}.`
        : `${wait}No clear side: wait for the first 15 minutes; CE above ${r0(prevHigh)}, PE below ${r0(prevLow)}.`;

  return {
    symbol: x.symbol,
    label: x.label,
    prevClose,
    prevHigh,
    prevLow,
    closePos,
    dayChangePct,
    trendAtClose,
    pivot,
    r1,
    s1,
    expectedOpen,
    gapPct,
    gapFrom,
    bias,
    score,
    signs,
    plan,
  };
}

export function preMarketReport(inputs: PreMarketInput[], now: number, opts: { gapGuard: boolean; gapGuardPct: number }): PreMarketReport {
  const phase = preMarketPhase(now);
  const items = inputs.map((x) => preMarketItem(x, now, opts)).filter((i): i is PreMarketItem => !!i);
  const word = (bi: Bias) => (bi === 'BULLISH' ? 'leans up' : bi === 'BEARISH' ? 'leans down' : 'no clear side');
  const headline = items.length
    ? `Pre-market${phase === 'BEFORE' ? ' (yesterday only; pre-open prices from 9:00)' : phase === 'PREOPEN' ? ' (with pre-open prices)' : ''}: ` +
      items.map((i) => `${i.label} ${word(i.bias)}${i.gapPct != null ? `, gap ${i.gapPct >= 0 ? '+' : '−'}${Math.abs(i.gapPct).toFixed(2)}%` : ''}`).join(' · ')
    : 'Pre-market: no data yet';
  const parts = items.map((i) => {
    const gap = i.gapPct == null ? '' : Math.abs(i.gapPct) < 0.15 ? ' Flat open expected.' : ` Expected gap ${i.gapPct > 0 ? 'up' : 'down'} ${Math.abs(i.gapPct).toFixed(1)} percent.`;
    const said = i.signs.filter((x) => !x.startsWith('gap ')).join(', ');
    const why = said ? ` ${said[0].toUpperCase()}${said.slice(1)}.` : '';
    return `${spoken(i.label)}: ${word(i.bias)}.${gap}${why} ${i.plan}`;
  });
  const speech = items.length ? `Pre-market report. ${parts.join(' ')} No orders before 9:15.`.replace(/\s+/g, ' ').trim() : '';
  const gapSide = (g: number | null) => (g == null ? '?' : g >= 0.15 ? 'U' : g <= -0.15 ? 'D' : 'F');
  const key = `${istDay(now)}|${phase}|${items.map((i) => `${i.symbol}:${i.bias}:${gapSide(i.gapPct)}`).join(',')}`;
  return { phase, at: now, items, headline, speech, key };
}
