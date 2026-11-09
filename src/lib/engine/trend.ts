/**
 * Trend finder ("the trend is your friend"): on the 5-min candles, which way the market is
 * trending, when that trend really began, how long it has run, how far it has gone, how strong
 * it is, how its age compares with this index's recent trends, and the signs that it is ending.
 *
 *  - Direction: EMA20 vs EMA50 (with a small dead band), ADX(14) for strength; sideways when ADX
 *    is low and the EMAs are close together.
 *  - Start: not the (late) EMA crossover itself but the turning point before it — the lowest low
 *    (uptrend) / highest high (downtrend) between the previous trend's start and the crossover.
 *  - Ending signs: ADX falling from its peak, RSI divergence at the last two swing highs/lows,
 *    a close back through EMA20, a broken swing low/high (structure), price stretched far from
 *    EMA20, an age past most recent trends, and a 15-min chart that disagrees.
 * Display / guidance only: the engine's entry rules don't use it.
 */
import { computeTechnical, istDay } from './indicators.ts';
import type { Candle } from './types.ts';

export type TrendDir = 'UP' | 'DOWN' | 'SIDEWAYS';
export type TrendPhase = 'STARTING' | 'RUNNING' | 'MATURE' | 'EXHAUSTING' | 'REVERSING' | 'SIDEWAYS';

export interface TrendSegment {
  dir: 'UP' | 'DOWN';
  /** Turning point the trend began from (ms) and its price. */
  start: number;
  startPrice: number;
  /** Last candle of the trend (ms); the current trend: the latest candle. */
  end: number;
  endPrice: number;
  minutes: number;
  movePts: number;
}

export interface TrendReport {
  direction: TrendDir;
  /** Which way it leans when sideways (EMA20 vs EMA50). */
  lean: 'UP' | 'DOWN';
  phase: TrendPhase;
  /** 0–100: ADX, how many candles closed with the trend, and the 15-min chart agreeing. */
  strength: number;
  price: number;
  at: number;
  startedAt: number | null;
  startPrice: number | null;
  /** Market minutes since the start (5 per candle; overnight not counted). */
  ageMin: number;
  movePts: number;
  movePct: number;
  /** Move in ATRs (how big the trend is for this index). */
  moveAtr: number;
  adx: number;
  adxRising: boolean;
  rsi: number;
  atr: number;
  ema20: number;
  ema50: number;
  /** Distance of the price from EMA20, in ATRs (stretched above ~2.5). */
  stretchAtr: number;
  /** The 15-min chart's trend. */
  higherTf: TrendDir;
  /** Median length of this index's finished trends in the data, and how many there were. */
  typicalMin: number | null;
  pastTrends: number;
  /** Share of the finished trends that were shorter than this one (0–100). */
  agePercentile: number | null;
  /** Last swing high / low (structure). */
  swingHigh: number | null;
  swingLow: number | null;
  warnings: string[];
  verdict: string;
  /** Today's trends, oldest first (the last one is the current trend). */
  today: TrendSegment[];
  /** Today's opening gap against yesterday (null without yesterday's candles). */
  gap: GapReport | null;
}

export type GapStatus = 'FLAT' | 'WAIT_15' | 'GAP_AND_GO' | 'HOLDING' | 'FILLING' | 'FILLED';

export interface GapReport {
  date: string;
  prevClose: number;
  prevHigh: number;
  prevLow: number;
  open: number;
  gapPts: number;
  gapPct: number;
  /** Gap size in yesterday's closing ATRs. */
  gapAtr: number;
  kind: 'FLAT' | 'GAP_UP' | 'GAP_DOWN';
  /** Opened beyond yesterday's high (gap up) / low (gap down). */
  full: boolean;
  /** How much of the gap has been given back: at worst today, and now (0–100+). */
  maxFillPct: number;
  fillNowPct: number;
  /** Price has been back to yesterday's close. */
  filled: boolean;
  /** First 15 minutes (three 5-min candles): its range, done or not, and which side broke since. */
  orb: { high: number; low: number; done: boolean; endsAt: number; broke: 'UP' | 'DOWN' | 'BOTH' | null };
  status: GapStatus;
  verdict: string;
}

/** A gap smaller than this (%) counts as a flat open. */
export const FLAT_GAP_PCT = 0.25;

/** Today's opening gap: size, full / partial, fill so far, first-15-minute range and what it's doing. */
export function findGap(candles: Candle[], atr?: number[]): GapReport | null {
  const c = candles.filter((x) => x.c > 0);
  if (c.length < 2) return null;
  const L = c.length - 1;
  const date = istDay(c[L].t);
  const first = c.findIndex((x) => istDay(x.t) === date);
  if (first <= 0) return null; // no previous day in the data
  const prevDay = istDay(c[first - 1].t);
  const prev = c.filter((x) => istDay(x.t) === prevDay);
  const prevClose = prev[prev.length - 1].c;
  const prevHigh = Math.max(...prev.map((x) => x.h));
  const prevLow = Math.min(...prev.map((x) => x.l));
  const today = c.slice(first);
  const open = today[0].o > 0 ? today[0].o : today[0].c;
  const gapPts = open - prevClose;
  const gapPct = (100 * gapPts) / prevClose;
  const a = atr?.[first - 1] || prev.reduce((m, x) => m + (x.h - x.l), 0) / prev.length || 1;
  const kind = Math.abs(gapPct) < FLAT_GAP_PCT ? 'FLAT' : gapPts > 0 ? 'GAP_UP' : 'GAP_DOWN';
  const up = gapPts > 0;
  const full = up ? open > prevHigh : open < prevLow;
  const price = c[L].c;
  const lowT = Math.min(...today.map((x) => x.l));
  const highT = Math.max(...today.map((x) => x.h));
  const size = Math.abs(gapPts) || 1;
  const maxFillPct = Math.max(0, (100 * (up ? open - lowT : highT - open)) / size);
  const fillNowPct = (100 * (up ? open - price : price - open)) / size;
  const filled = up ? lowT <= prevClose : highT >= prevClose;
  const orbBars = today.slice(0, 3);
  const orb = {
    high: Math.max(...orbBars.map((x) => x.h)),
    low: Math.min(...orbBars.map((x) => x.l)),
    done: false,
    endsAt: today[0].t + 15 * 60_000,
    broke: null as 'UP' | 'DOWN' | 'BOTH' | null,
  };
  orb.done = today.length > 3; // three opening candles finished (a fourth has started)
  if (orb.done) {
    const after = today.slice(3);
    const bu = after.some((x) => x.h > orb.high);
    const bd = after.some((x) => x.l < orb.low);
    orb.broke = bu && bd ? 'BOTH' : bu ? 'UP' : bd ? 'DOWN' : null;
  }
  const withGap = up ? 'UP' : 'DOWN';
  const against = up ? 'DOWN' : 'UP';
  let status: GapStatus;
  if (kind === 'FLAT') status = 'FLAT';
  else if (!orb.done) status = 'WAIT_15';
  else if (filled) status = 'FILLED';
  else if (fillNowPct >= 50 || orb.broke === against) status = 'FILLING';
  else if (orb.broke === withGap || orb.broke === 'BOTH') status = fillNowPct < 50 ? 'GAP_AND_GO' : 'FILLING';
  else status = 'HOLDING';
  const word = up ? 'up' : 'down';
  const side = up ? 'CE' : 'PE';
  const otherSide = up ? 'PE' : 'CE';
  const sz = `${Math.abs(gapPct).toFixed(2)}% (${Math.abs(gapPts).toFixed(0)} pts, ${(Math.abs(gapPts) / a).toFixed(1)} ATR)`;
  const verdict = {
    FLAT: `Flat open (${gapPct >= 0 ? '+' : ''}${gapPct.toFixed(2)}%): no gap to play — follow the day's own trend.`,
    WAIT_15: `Gap ${word} ${sz}: wait for the first 15 minutes to finish before trading it — don't chase the opening candle.`,
    GAP_AND_GO: `Gap ${word} holding and the first-15-min ${up ? 'high' : 'low'} broke: gap-and-go — ${side} with it while price stays beyond the opening range.`,
    HOLDING: `Gap ${word} holding inside the first-15-min range: wait for a break — ${up ? 'above' : 'below'} ${(up ? orb.high : orb.low).toFixed(0)} = go, ${up ? 'below' : 'above'} ${(up ? orb.low : orb.high).toFixed(0)} = filling.`,
    FILLING: `Gap ${word} is filling (${Math.max(0, fillNowPct).toFixed(0)}% given back): no fresh ${side}; the fill target is yesterday's close ${prevClose.toFixed(0)} (${otherSide} side).`,
    FILLED: `Gap ${word} fully filled (back to yesterday's close ${prevClose.toFixed(0)}): the gap is done — trade the day's own trend.`,
  }[status];
  return {
    date,
    prevClose,
    prevHigh,
    prevLow,
    open,
    gapPts,
    gapPct,
    gapAtr: gapPts / a,
    kind,
    full: kind !== 'FLAT' && full,
    maxFillPct,
    fillNowPct,
    filled: kind !== 'FLAT' && filled,
    orb,
    status,
    verdict,
  };
}

/**
 * Gap guard for the engine: after a big gap (≥ minPct) no new entry until the first 15 minutes are
 * over — the opening candles of a gap swing hardest. Returns the reason, or null.
 */
export function gapEntryBlock(candles: Candle[], now: number, minPct: number): string | null {
  const g = findGap(candles);
  if (!g || g.kind === 'FLAT' || Math.abs(g.gapPct) < minPct) return null;
  if (now >= g.orb.endsAt) return null;
  const until = new Date(g.orb.endsAt + 5.5 * 3600_000).toISOString().slice(11, 16);
  return `Gap ${g.gapPts > 0 ? 'up' : 'down'} ${Math.abs(g.gapPct).toFixed(2)}% at the open — waiting for the first 15 minutes (until ${until})`;
}

const CANDLE_MIN = 5;

function rsiSeries(c: Candle[], n = 14): number[] {
  const out = new Array<number>(c.length).fill(50);
  let g = 0;
  let l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i].c - c[i - 1].c;
    const up = Math.max(0, d);
    const dn = Math.max(0, -d);
    if (i <= n) {
      g += up / n;
      l += dn / n;
    } else {
      g = (g * (n - 1) + up) / n;
      l = (l * (n - 1) + dn) / n;
    }
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

/** ADX(14), Wilder. */
function adxSeries(c: Candle[], n = 14): number[] {
  const len = c.length;
  const adx = new Array<number>(len).fill(0);
  let trS = 0;
  let pS = 0;
  let mS = 0;
  let dxS = 0;
  for (let i = 1; i < len; i++) {
    const up = c[i].h - c[i - 1].h;
    const dn = c[i - 1].l - c[i].l;
    const pdm = up > dn && up > 0 ? up : 0;
    const mdm = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
    trS = i <= n ? trS + tr : trS - trS / n + tr;
    pS = i <= n ? pS + pdm : pS - pS / n + pdm;
    mS = i <= n ? mS + mdm : mS - mS / n + mdm;
    const pdi = trS > 0 ? (100 * pS) / trS : 0;
    const mdi = trS > 0 ? (100 * mS) / trS : 0;
    const dx = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
    dxS = i <= n ? dxS + dx / n : (dxS * (n - 1) + dx) / n;
    adx[i] = dxS;
  }
  return adx;
}

/** Swing highs / lows: a high (low) above (below) the 2 candles on each side. */
function swings(c: Candle[]): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = 2; i < c.length - 2; i++) {
    if (c[i].h > c[i - 1].h && c[i].h > c[i - 2].h && c[i].h >= c[i + 1].h && c[i].h >= c[i + 2].h) highs.push(i);
    if (c[i].l < c[i - 1].l && c[i].l < c[i - 2].l && c[i].l <= c[i + 1].l && c[i].l <= c[i + 2].l) lows.push(i);
  }
  return { highs, lows };
}

/** 5-min candles → 15-min candles (per day, aligned on the day's first candle). */
export function to15m(c: Candle[]): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let k = 0;
  let day = '';
  for (const x of c) {
    const d = istDay(x.t);
    if (!cur || d !== day || k === 3) {
      if (cur) out.push(cur);
      cur = { ...x };
      k = 1;
      day = d;
    } else {
      const prev: Candle = cur;
      cur = { ...prev, h: Math.max(prev.h, x.h), l: Math.min(prev.l, x.l), c: x.c, v: prev.v + x.v };
      k++;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Direction per candle from EMA20 vs EMA50 with a dead band; short flips (< 3 candles) are ignored. */
function regimes(ema20: number[], ema50: number[], atr: number[]): ('UP' | 'DOWN')[] {
  const out: ('UP' | 'DOWN')[] = [];
  let cur: 'UP' | 'DOWN' = ema20[0] >= ema50[0] ? 'UP' : 'DOWN';
  for (let i = 0; i < ema20.length; i++) {
    const band = 0.05 * (atr[i] || 0);
    if (cur === 'UP' && ema20[i] < ema50[i] - band) cur = 'DOWN';
    else if (cur === 'DOWN' && ema20[i] > ema50[i] + band) cur = 'UP';
    out.push(cur);
  }
  // Smooth: a run shorter than 3 candles takes its neighbours' direction.
  let i = 0;
  while (i < out.length) {
    let j = i;
    while (j + 1 < out.length && out[j + 1] === out[i]) j++;
    if (j - i + 1 < 3 && i > 0 && j < out.length - 1) for (let k = i; k <= j; k++) out[k] = out[i - 1];
    i = j + 1;
  }
  return out;
}

/** Trend segments with their real turning points. */
function segmentsOf(c: Candle[], reg: ('UP' | 'DOWN')[]): TrendSegment[] {
  const runs: { dir: 'UP' | 'DOWN'; from: number; to: number }[] = [];
  for (let i = 0; i < reg.length; i++) {
    if (!runs.length || runs[runs.length - 1].dir !== reg[i]) runs.push({ dir: reg[i], from: i, to: i });
    else runs[runs.length - 1].to = i;
  }
  return runs.map((r, idx) => {
    // The turning point: extreme between the previous run's start and a couple of candles into this one.
    const lo = idx > 0 ? runs[idx - 1].from : r.from;
    const hi = Math.min(r.to, r.from + 2);
    let p = r.from;
    for (let k = lo; k <= hi; k++) {
      if (r.dir === 'UP' ? c[k].l < c[p].l : c[k].h > c[p].h) p = k;
    }
    const startPrice = r.dir === 'UP' ? c[p].l : c[p].h;
    const endPrice = c[r.to].c;
    return {
      dir: r.dir,
      start: c[p].t,
      startPrice,
      end: c[r.to].t,
      endPrice,
      minutes: (r.to - p + 1) * CANDLE_MIN,
      movePts: endPrice - startPrice,
    };
  });
}

const fmtMin = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);

export function findTrend(candles: Candle[]): TrendReport | null {
  const c = candles.filter((x) => x.c > 0);
  if (c.length < 30) return null;
  const tech = computeTechnical(c)!;
  const { ema20, ema50, atr } = tech;
  const L = c.length - 1;
  const price = c[L].c;
  const adx = adxSeries(c);
  const rsi = rsiSeries(c);
  const reg = regimes(ema20, ema50, atr);
  const segs = segmentsOf(c, reg);
  const cur = segs[segs.length - 1];
  const done = segs.slice(0, -1).filter((s) => s.minutes >= 15);
  const a = atr[L] || 1;
  const sideways = adx[L] < 18 && Math.abs(ema20[L] - ema50[L]) < 0.3 * a;
  const direction: TrendDir = sideways ? 'SIDEWAYS' : cur.dir;
  const sign = cur.dir === 'UP' ? 1 : -1;

  // Market minutes since the start (candles × 5: the overnight gap isn't counted).
  const startIdx = c.findIndex((x) => x.t === cur.start);
  const ageMin = (L - startIdx + 1) * CANDLE_MIN;
  const movePts = price - cur.startPrice;

  const durations = done.map((s) => s.minutes).sort((x, y) => x - y);
  const typicalMin = durations.length ? durations[Math.floor(durations.length / 2)] : null;
  const agePercentile = durations.length ? Math.round((100 * durations.filter((d) => d < ageMin).length) / durations.length) : null;

  // 15-min chart.
  const c15 = to15m(c);
  let higherTf: TrendDir = 'SIDEWAYS';
  if (c15.length >= 25) {
    const t15 = computeTechnical(c15)!;
    const n = c15.length - 1;
    const d = t15.ema20[n] - t15.ema50[n];
    if (Math.abs(d) >= 0.2 * (t15.atr[n] || 1)) higherTf = d > 0 ? 'UP' : 'DOWN';
  }

  // Structure and divergence.
  const { highs, lows } = swings(c);
  const lastHigh = highs.length ? c[highs[highs.length - 1]].h : null;
  const lastLow = lows.length ? c[lows[lows.length - 1]].l : null;
  const warnings: string[] = [];
  let reversing = false;
  if (!sideways) {
    // ADX turning down from a strong reading.
    const peak = Math.max(...adx.slice(Math.max(startIdx, L - 12), L + 1));
    if (peak >= 25 && adx[L] < peak - 3 && adx[L] < adx[L - 1] && adx[L - 1] < adx[L - 2])
      warnings.push(`Strength fading: ADX ${adx[L].toFixed(0)}, down from ${peak.toFixed(0)}`);
    // RSI divergence at the last two swings in the trend's direction.
    const piv = cur.dir === 'UP' ? highs : lows;
    const recent = piv.filter((i) => i >= startIdx);
    if (recent.length >= 2) {
      const [i1, i2] = recent.slice(-2);
      const p1 = cur.dir === 'UP' ? c[i1].h : c[i1].l;
      const p2 = cur.dir === 'UP' ? c[i2].h : c[i2].l;
      if (sign * (p2 - p1) > 0 && sign * (rsi[i2] - rsi[i1]) < -2)
        warnings.push(`Momentum divergence: new ${cur.dir === 'UP' ? 'high' : 'low'} but weaker RSI (${rsi[i1].toFixed(0)} → ${rsi[i2].toFixed(0)})`);
    }
    // Close back through EMA20.
    if (sign * (price - ema20[L]) < 0) warnings.push(`Price closed back ${cur.dir === 'UP' ? 'below' : 'above'} EMA20 (${ema20[L].toFixed(1)})`);
    // Structure: the last swing low (uptrend) / high (downtrend) broken.
    const guard = cur.dir === 'UP' ? lows.filter((i) => i >= startIdx && i < L - 1) : highs.filter((i) => i >= startIdx && i < L - 1);
    if (guard.length) {
      const lvl = cur.dir === 'UP' ? c[guard[guard.length - 1]].l : c[guard[guard.length - 1]].h;
      if (sign * (price - lvl) < 0) {
        reversing = true;
        warnings.push(`Structure broken: price ${cur.dir === 'UP' ? 'below the last higher low' : 'above the last lower high'} ${lvl.toFixed(1)}`);
      }
    }
    const stretch = (price - ema20[L]) / a;
    if (sign * stretch > 2.5) warnings.push(`Stretched: ${Math.abs(stretch).toFixed(1)} ATR from EMA20 — pullback risk`);
    if (agePercentile != null && durations.length >= 3 && agePercentile >= 75)
      warnings.push(`Old trend: ${fmtMin(ageMin)}, longer than ${agePercentile}% of the last ${durations.length} trends (typical ${fmtMin(typicalMin!)})`);
    if (higherTf !== 'SIDEWAYS' && higherTf !== cur.dir) warnings.push(`15-min chart is still ${higherTf === 'UP' ? 'up' : 'down'}: against the bigger trend`);
  }

  // Strength 0–100.
  const sinceStart = c.slice(startIdx);
  const withTrend = sinceStart.filter((x) => sign * (x.c - x.o) > 0).length / Math.max(1, sinceStart.length);
  const strength = sideways
    ? Math.round(Math.min(40, adx[L]))
    : Math.round(Math.min(50, adx[L]) + 30 * withTrend + (higherTf === cur.dir ? 20 : 0));

  let phase: TrendPhase;
  if (sideways) phase = 'SIDEWAYS';
  else if (reversing) phase = 'REVERSING';
  else if (warnings.length >= 2) phase = 'EXHAUSTING';
  else if (ageMin <= 30) phase = 'STARTING';
  else if (typicalMin != null && ageMin >= typicalMin) phase = 'MATURE';
  else phase = 'RUNNING';

  const side = cur.dir === 'UP' ? 'CE' : 'PE';
  const other = cur.dir === 'UP' ? 'PE' : 'CE';
  const verdict = {
    SIDEWAYS: `No clear trend (ADX ${adx[L].toFixed(0)}): a range market — option buying fights time decay here; wait for a breakout.`,
    STARTING: `New ${cur.dir} trend, ${fmtMin(ageMin)} old: early — ${side} setups go with it; confirm it holds before sizing up.`,
    RUNNING: `${cur.dir} trend running for ${fmtMin(ageMin)}: trade with it (${side}); avoid ${other} against it.`,
    MATURE: `${cur.dir} trend is mature (${fmtMin(ageMin)}): still ${side} with it, but take profits quicker and don't chase.`,
    EXHAUSTING: `${cur.dir} trend is tiring (${warnings.length} warning signs): avoid fresh ${side} entries at extremes; protect profits.`,
    REVERSING: `${cur.dir} trend looks broken: no new ${side}; wait for a new trend to form before entering.`,
  }[phase];

  const todayKey = istDay(c[L].t);
  const today = segs.filter((s) => istDay(s.end) === todayKey && s.minutes >= 10);

  return {
    direction,
    lean: cur.dir,
    phase,
    strength: Math.max(0, Math.min(100, strength)),
    price,
    at: c[L].t,
    startedAt: cur.start,
    startPrice: cur.startPrice,
    ageMin,
    movePts,
    movePct: (100 * movePts) / cur.startPrice,
    moveAtr: movePts / a,
    adx: adx[L],
    adxRising: adx[L] > adx[L - 1],
    rsi: rsi[L],
    atr: a,
    ema20: ema20[L],
    ema50: ema50[L],
    stretchAtr: (price - ema20[L]) / a,
    higherTf,
    typicalMin,
    pastTrends: durations.length,
    agePercentile,
    swingHigh: lastHigh,
    swingLow: lastLow,
    warnings,
    verdict,
    today,
    gap: findGap(c, atr),
  };
}

// ---------------------------------------------------------------- entry strength (trend + Greeks)

export interface EntryStrength {
  /** 0–100: the trend, its phase, and whether the option's Greeks pay for riding it. */
  score: number;
  label: 'STRONG' | 'OK' | 'WEAK';
  side: 'CE' | 'PE';
  strike: number;
  premium: number;
  delta: number;
  gamma: number;
  /** Per day (premium points). */
  theta: number;
  vega: number;
  iv: number;
  ivPercentile: number | null;
  daysToExpiry: number;
  /** Index points per hour in the trend's direction (recent half hour and the whole trend, blended). */
  speedPtsHr: number;
  /** What the trend's speed should add to the premium per hour (delta + gamma), and what time takes. */
  gainPerHr: number;
  thetaPerHr: number;
  /** gain ÷ decay: above 2 the move pays well for the time; below 1 time decay wins. */
  edge: number;
  notes: string[];
}

const TRADING_HOURS = 6.25;

/**
 * How good an option entry with the trend is right now: the trend part (strength, phase) and the
 * Greeks part — delta + gamma turn the trend's speed into premium per hour, theta takes premium per
 * hour, IV percentile says whether premiums are cheap or dear (IV crush risk), and expiry closeness.
 */
export function entryStrength(
  t: TrendReport,
  candles: Candle[],
  leg: { strike: number; ltp: number; delta: number; gamma: number; theta: number; vega: number; iv: number } | null,
  o: { ivPercentile: number | null; daysToExpiry: number },
): EntryStrength | null {
  if (!leg || !(leg.ltp > 0)) return null;
  const side = t.lean === 'UP' ? 'CE' : 'PE';
  const sign = t.lean === 'UP' ? 1 : -1;
  const L = candles.length - 1;
  const recent = L >= 6 ? sign * (candles[L].c - candles[L - 6].c) * 2 : 0; // last 30 min → per hour
  const whole = t.ageMin > 0 ? (sign * t.movePts) / (t.ageMin / 60) : 0;
  const speed = Math.max(0, 0.5 * recent + 0.5 * whole);
  const d = Math.abs(leg.delta);
  const gainPerHr = d * speed + 0.5 * Math.abs(leg.gamma) * speed * speed;
  const thetaPerHr = Math.abs(leg.theta) / TRADING_HOURS;
  const edge = thetaPerHr > 0 ? Math.min(10, gainPerHr / thetaPerHr) : gainPerHr > 0 ? 10 : 0;

  const notes: string[] = [];
  let score = t.strength;
  score += { STARTING: 5, RUNNING: 5, MATURE: -10, EXHAUSTING: -25, REVERSING: -45, SIDEWAYS: -10 }[t.phase];
  if (t.phase === 'SIDEWAYS') score = Math.min(score, 25);
  if (edge >= 3) {
    score += 15;
    notes.push(`The trend's speed pays ${edge.toFixed(1)}× the time decay — strong for buying`);
  } else if (edge >= 2) {
    score += 10;
    notes.push(`The move pays ${edge.toFixed(1)}× the time decay`);
  } else if (edge >= 1) {
    notes.push(`The move only just beats time decay (${edge.toFixed(1)}×)`);
  } else if (edge >= 0.5) {
    score -= 10;
    notes.push(`Time decay eats most of the move (${edge.toFixed(1)}×) — needs the trend to speed up`);
  } else {
    score -= 20;
    notes.push(`Time decay beats the move (${edge.toFixed(1)}×) — buying options loses here`);
  }
  const ivp = o.ivPercentile != null && o.ivPercentile >= 0 ? o.ivPercentile : null; // < 0: not enough IV history yet
  if (ivp != null) {
    if (ivp > 80) {
      score -= 10;
      notes.push(`IV is high (${ivp.toFixed(0)} percentile): premiums are dear; an IV drop costs ₹${(leg.vega).toFixed(1)} per point per unit`);
    } else if (ivp > 65) {
      score -= 5;
      notes.push(`IV on the high side (${ivp.toFixed(0)} percentile)`);
    } else if (ivp < 30) {
      score += 5;
      notes.push(`IV is low (${ivp.toFixed(0)} percentile): premiums are cheap`);
    }
  }
  if (d < 0.3) {
    score -= 5;
    notes.push(`Delta ${d.toFixed(2)}: far out of the money — needs a big move`);
  } else if (d > 0.7) notes.push(`Delta ${d.toFixed(2)}: deep in the money — moves like the index, costs more`);
  if (o.daysToExpiry <= 1)
    notes.push(`Expiry ${o.daysToExpiry <= 0.5 ? 'today' : 'tomorrow'}: gamma and theta are at their highest — fast both ways`);
  // The trend's phase caps it: a tiring or breaking trend is never a strong entry, however good the Greeks.
  const cap = { STARTING: 100, RUNNING: 100, MATURE: 85, EXHAUSTING: 60, REVERSING: 35, SIDEWAYS: 25 }[t.phase];
  if (score > cap) {
    score = cap;
    if (t.phase === 'EXHAUSTING' || t.phase === 'REVERSING') notes.push(`Capped at ${cap}: the trend is ${t.phase === 'EXHAUSTING' ? 'tiring' : 'breaking'}`);
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score,
    label: score >= 70 ? 'STRONG' : score >= 50 ? 'OK' : 'WEAK',
    side,
    strike: leg.strike,
    premium: leg.ltp,
    delta: leg.delta,
    gamma: leg.gamma,
    theta: leg.theta,
    vega: leg.vega,
    iv: leg.iv,
    ivPercentile: ivp,
    daysToExpiry: o.daysToExpiry,
    speedPtsHr: speed,
    gainPerHr,
    thetaPerHr,
    edge,
    notes,
  };
}

// ---------------------------------------------------------------- trend filter for entries

export interface TrendFilterCfg {
  trendFilter: boolean;
  trendBlockSideways: boolean;
  trendBlockTiring: boolean;
  /** Minimum trend strength (0–100, 0 = off). */
  trendMinStrength: number;
}

/**
 * Entry filter ("the trend is your friend"): a new entry only with the trend — CE / LONG in an UP
 * trend, PE / SHORT in a DOWN trend; optionally none when sideways, none when the trend is tiring or
 * breaking, and none below a minimum strength. Returns the reason to wait, or null.
 */
export function trendEntryBlock(candles: Candle[], direction: string, cfg: TrendFilterCfg): string | null {
  if (!cfg.trendFilter) return null;
  const t = findTrend(candles);
  if (!t) return null; // not enough candles yet: no opinion
  const want: 'UP' | 'DOWN' = direction === 'CE' || direction === 'LONG' ? 'UP' : 'DOWN';
  const since = t.startedAt ? new Date(t.startedAt + 5.5 * 3600_000).toISOString().slice(11, 16) : '';
  const age = t.ageMin >= 60 ? `${Math.floor(t.ageMin / 60)}h ${t.ageMin % 60}m` : `${t.ageMin}m`;
  if (t.direction === 'SIDEWAYS') {
    return cfg.trendBlockSideways
      ? `Trend filter: no trend (sideways, ADX ${t.adx.toFixed(0)}) — waiting for one to form`
      : null;
  }
  if (t.direction !== want) {
    const ok = want === 'UP' ? 'PE' : 'CE';
    return `Trend filter: ${direction} is against the ${t.direction} trend (since ${since}, ${age}) — only ${ok} with the trend`;
  }
  if (cfg.trendBlockTiring && (t.phase === 'EXHAUSTING' || t.phase === 'REVERSING'))
    return `Trend filter: the ${t.direction} trend is ${t.phase === 'EXHAUSTING' ? 'tiring' : 'breaking'} (${t.warnings[0] ?? 'ending signs'}) — no fresh entry`;
  if (cfg.trendMinStrength > 0 && t.strength < cfg.trendMinStrength)
    return `Trend filter: the ${t.direction} trend is weak (strength ${t.strength} < ${cfg.trendMinStrength})`;
  return null;
}
