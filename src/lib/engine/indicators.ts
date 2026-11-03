/**
 * Port of modAnalytics (ComputeTechnical, ComputeOptionChainMetrics).
 */
import type { Candle, ChainSnapshot, ChainStrike, Leg } from './types.ts';

/** IST calendar day of a candle (the workbook resets VWAP/ATR on day change). */
export const istDay = (t: number) => new Date(t + 5.5 * 3600_000).toISOString().slice(0, 10);

export interface Technical {
  ema20: number[];
  ema50: number[];
  vwap: number[];
  atr: number[];
  /** Latest values */
  last: { ema20: number; ema50: number; vwap: number; atr: number; close: number };
  trend: 'BULLISH' | 'BEARISH' | 'SIDEWAYS';
}

export function computeTechnical(c: Candle[]): Technical | null {
  const n = c.length;
  if (n < 1) return null;
  const ema20 = new Array<number>(n);
  const ema50 = new Array<number>(n);
  const k20 = 2 / 21;
  const k50 = 2 / 51;
  ema20[0] = c[0].c;
  ema50[0] = c[0].c;
  for (let i = 1; i < n; i++) {
    ema20[i] = c[i].c * k20 + ema20[i - 1] * (1 - k20);
    ema50[i] = c[i].c * k50 + ema50[i - 1] * (1 - k50);
  }

  // Session VWAP: resets at the start of every trading day.
  const vwap = new Array<number>(n);
  let cumPV = 0;
  let cumV = 0;
  for (let i = 0; i < n; i++) {
    if (i === 0 || istDay(c[i].t) !== istDay(c[i - 1].t)) {
      cumPV = 0;
      cumV = 0;
    }
    const typical = (c[i].h + c[i].l + c[i].c) / 3;
    cumPV += typical * c[i].v;
    cumV += c[i].v;
    vwap[i] = cumV > 0 ? cumPV / cumV : c[i].c;
  }

  // ATR14 (Wilder). First candle of a day uses High-Low only, ignoring the overnight gap.
  const tr = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const newDay = i === 0 || istDay(c[i].t) !== istDay(c[i - 1].t);
    tr[i] = newDay
      ? c[i].h - c[i].l
      : Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
  }
  const atr = new Array<number>(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    if (i < 14) {
      sum += tr[i];
      atr[i] = sum / (i + 1);
    } else {
      atr[i] = (atr[i - 1] * 13 + tr[i]) / 14;
    }
  }

  const L = n - 1;
  const close = c[L].c;
  let trend: Technical['trend'] = 'SIDEWAYS';
  if (ema20[L] > ema50[L] && close > ema20[L] && close > vwap[L]) trend = 'BULLISH';
  else if (ema20[L] < ema50[L] && close < ema20[L] && close < vwap[L]) trend = 'BEARISH';
  return {
    ema20,
    ema50,
    vwap,
    atr,
    last: { ema20: ema20[L], ema50: ema50[L], vwap: vwap[L], atr: atr[L], close },
    trend,
  };
}

export interface ChainMetrics {
  pcr: number;
  maxPain: number;
  /** Highest PE OI strike */
  support: number;
  /** Highest CE OI strike */
  resistance: number;
  atm: number;
}

export function computeChainMetrics(chain: ChainSnapshot): ChainMetrics | null {
  const s = chain.strikes;
  if (!s.length) return null;
  const spot = chain.spot;
  let totalCE = 0;
  let totalPE = 0;
  let maxCE = 0;
  let maxCEStrike = 0;
  let maxPE = 0;
  let maxPEStrike = 0;
  let atm = 0;
  let atmDiff = Infinity;
  const ceOI = s.map((x) => x.ce?.oi ?? 0);
  const peOI = s.map((x) => x.pe?.oi ?? 0);
  for (let i = 0; i < s.length; i++) {
    totalCE += ceOI[i];
    totalPE += peOI[i];
    if (ceOI[i] > maxCE) {
      maxCE = ceOI[i];
      maxCEStrike = s[i].strike;
    }
    if (peOI[i] > maxPE) {
      maxPE = peOI[i];
      maxPEStrike = s[i].strike;
    }
    if (Math.abs(s[i].strike - spot) < atmDiff) {
      atmDiff = Math.abs(s[i].strike - spot);
      atm = s[i].strike;
    }
  }
  const pcr = totalCE > 0 ? totalPE / totalCE : 0;

  // Max pain: strike where total option-writer payout is minimised.
  let minPain = Infinity;
  let maxPain = 0;
  for (let a = 0; a < s.length; a++) {
    const K = s[a].strike;
    let pain = 0;
    for (let b = 0; b < s.length; b++) {
      if (s[b].strike < K) pain += ceOI[b] * (K - s[b].strike);
      else if (s[b].strike > K) pain += peOI[b] * (s[b].strike - K);
    }
    if (pain < minPain) {
      minPain = pain;
      maxPain = K;
    }
  }
  return { pcr, maxPain, support: maxPEStrike, resistance: maxCEStrike, atm };
}

/** Nearest strike row (FindOptionRow). */
export function findStrike(chain: ChainSnapshot, strike: number): ChainStrike | null {
  let best: ChainStrike | null = null;
  let diff = Infinity;
  for (const s of chain.strikes) {
    const d = Math.abs(s.strike - strike);
    if (d < diff) {
      diff = d;
      best = s;
    }
  }
  return best;
}

export const legOf = (row: ChainStrike | null, dir: 'CE' | 'PE'): Leg | null =>
  row ? (dir === 'CE' ? row.ce : row.pe) : null;
