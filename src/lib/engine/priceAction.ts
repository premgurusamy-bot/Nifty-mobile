/**
 * Port of modPriceAction (v4): candlestick + level-reaction scoring on 5-min candles.
 */
import { istDay, type Technical } from './indicators.ts';
import type { Candle } from './types.ts';

export interface PriceActionResult {
  bull: number;
  bear: number;
  label: string;
}

/** Raw point ceiling used to rescale to 0-10 (PA_MAX_RAW). */
const PA_MAX_RAW = 26;

export interface Levels {
  oiSupport?: number;
  oiResistance?: number;
  swingSupport?: number;
  swingResistance?: number;
}

/** Score the candle at index `r` (needs r >= 1). */
export function scoreCandle(
  c: Candle[],
  tech: Technical,
  r: number,
  levels: Levels,
  includeOI: boolean,
): PriceActionResult {
  const cur = c[r];
  const prev = c[r - 1];
  const { o: o1, h: h1, l: l1, c: c1 } = cur;
  const { o: o2, h: h2, l: l2, c: c2 } = prev;
  const ema20 = tech.ema20[r];
  const vwap = tech.vwap[r];
  const atr = tech.atr[r];
  const tol = atr > 0 ? atr * 0.25 : c1 > 0 ? c1 * 0.001 : 0;

  const body1 = Math.abs(c1 - o1);
  const upperWick1 = h1 - Math.max(c1, o1);
  const lowerWick1 = Math.min(c1, o1) - l1;
  const range1 = h1 - l1;
  const body2 = Math.abs(c2 - o2);

  let rawBull = 0;
  let rawBear = 0;
  let bestLabel = 'NONE';
  let bestPts = 0;
  const mark = (pts: number, label: string) => {
    if (pts > bestPts) {
      bestPts = pts;
      bestLabel = label;
    }
  };
  let reversalBull = false;
  let reversalBear = false;
  let levelBull = false;
  let levelBear = false;

  if (c2 < o2 && c1 > o1 && c1 >= o2 && o1 <= c2 && body1 > body2) {
    rawBull += 8;
    reversalBull = true;
    mark(8, 'BULLISH ENGULFING');
  }
  if (c2 > o2 && c1 < o1 && c1 <= o2 && o1 >= c2 && body1 > body2) {
    rawBear += 8;
    reversalBear = true;
    mark(8, 'BEARISH ENGULFING');
  }
  if (lowerWick1 > body1 * 2 && upperWick1 < body1) {
    rawBull += 6;
    reversalBull = true;
    mark(6, 'BULLISH PIN BAR (HAMMER)');
  }
  if (upperWick1 > body1 * 2 && lowerWick1 < body1) {
    rawBear += 6;
    reversalBear = true;
    mark(6, 'BEARISH PIN BAR (SHOOTING STAR)');
  }
  if (range1 > 0 && body1 <= range1 * 0.1) {
    rawBull += 2;
    rawBear += 2;
    mark(2, 'DOJI (INDECISION)');
  }
  if (h1 < h2 && l1 > l2) {
    rawBull += 2;
    rawBear += 2;
    mark(2, 'INSIDE BAR');
  }
  if (ema20 > 0 && l1 <= ema20 + tol && c1 > ema20 && c1 > o1) {
    rawBull += 4;
    mark(4, 'PULLBACK TO EMA20 (BULLISH)');
  }
  if (ema20 > 0 && h1 >= ema20 - tol && c1 < ema20 && c1 < o1) {
    rawBear += 4;
    mark(4, 'PULLBACK TO EMA20 (BEARISH)');
  }
  if (vwap > 0 && l1 <= vwap + tol && c1 > vwap && c1 > o1) {
    rawBull += 3;
    mark(3, 'PULLBACK TO VWAP (BULLISH)');
  }
  if (vwap > 0 && h1 >= vwap - tol && c1 < vwap && c1 < o1) {
    rawBear += 3;
    mark(3, 'PULLBACK TO VWAP (BEARISH)');
  }
  if (includeOI) {
    const s = levels.oiSupport ?? 0;
    const res = levels.oiResistance ?? 0;
    if (s > 0 && l1 <= s + tol && c1 > o1) {
      rawBull += 3;
      levelBull = true;
      mark(3, 'OI SUPPORT REACTION');
    }
    if (res > 0 && h1 >= res - tol && c1 < o1) {
      rawBear += 3;
      levelBear = true;
      mark(3, 'OI RESISTANCE REACTION');
    }
  }
  const ss = levels.swingSupport ?? 0;
  const sr = levels.swingResistance ?? 0;
  if (ss > 0 && l1 <= ss + tol && c1 > o1) {
    rawBull += 2;
    levelBull = true;
    mark(2, 'SWING SUPPORT REACTION');
  }
  if (sr > 0 && h1 >= sr - tol && c1 < o1) {
    rawBear += 2;
    levelBear = true;
    mark(2, 'SWING RESISTANCE REACTION');
  }

  // Volume confirmation vs the previous (up to) 10 candles.
  const start = Math.max(0, r - 10);
  let vSum = 0;
  let vCount = 0;
  for (let i = start; i < r; i++) {
    vSum += c[i].v;
    vCount++;
  }
  const avgVol = vCount > 0 ? vSum / vCount : 0;
  if (avgVol > 0) {
    const add = cur.v >= avgVol * 1.5 ? 3 : cur.v >= avgVol ? 1 : 0;
    if (c1 > o1) rawBull += add;
    else if (c1 < o1) rawBear += add;
  }

  if (reversalBull && levelBull) {
    rawBull += 3;
    bestLabel += ' + LEVEL CONFLUENCE';
  }
  if (reversalBear && levelBear) {
    rawBear += 3;
    bestLabel += ' + LEVEL CONFLUENCE';
  }

  return {
    bull: Math.min(10, (rawBull * 10) / PA_MAX_RAW),
    bear: Math.min(10, (rawBear * 10) / PA_MAX_RAW),
    label: bestLabel,
  };
}

/**
 * Swing support/resistance from the last ~30 same-day candles up to index `u`
 * (GetPriceSwingLevels). Falls back to session high/low.
 */
export function swingLevels(c: Candle[], u: number): { support: number; resistance: number } {
  let support = 0;
  let resistance = 0;
  let start = Math.max(0, u - 30);
  const today = istDay(c[u].t);
  while (start < u && istDay(c[start].t) !== today) start++;
  if (u - start < 5) return { support, resistance };

  const close = c[u].c;
  let bestS = Infinity;
  let bestR = Infinity;
  let sessHigh = 0;
  let sessLow = Infinity;
  for (let r = start; r <= u; r++) {
    const { h, l } = c[r];
    if (h > sessHigh) sessHigh = h;
    if (l < sessLow) sessLow = l;
    if (r - 2 >= start && r + 2 <= u) {
      const isHigh = h >= c[r - 1].h && h >= c[r - 2].h && h >= c[r + 1].h && h >= c[r + 2].h;
      const isLow = l <= c[r - 1].l && l <= c[r - 2].l && l <= c[r + 1].l && l <= c[r + 2].l;
      if (isHigh && h > close && h - close < bestR) {
        bestR = h - close;
        resistance = h;
      }
      if (isLow && l < close && close - l < bestS) {
        bestS = close - l;
        support = l;
      }
    }
  }
  if (resistance === 0 && sessHigh > close) resistance = sessHigh;
  if (support === 0 && sessLow < close && sessLow < Infinity) support = sessLow;
  return { support, resistance };
}

/** Live entry point (GetPriceActionScore): needs at least 3 candles. */
export function livePriceAction(
  c: Candle[],
  tech: Technical,
  oiSupport: number,
  oiResistance: number,
): PriceActionResult & { swingSupport: number; swingResistance: number } {
  if (c.length < 3) return { bull: 0, bear: 0, label: 'NONE', swingSupport: 0, swingResistance: 0 };
  const u = c.length - 1;
  const sw = swingLevels(c, u);
  const pa = scoreCandle(
    c,
    tech,
    u,
    { oiSupport, oiResistance, swingSupport: sw.support, swingResistance: sw.resistance },
    true,
  );
  return { ...pa, swingSupport: sw.support, swingResistance: sw.resistance };
}
