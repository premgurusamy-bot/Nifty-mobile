/**
 * Market Memory — analysis of the recorded candles (pure):
 *  - tops and bottoms: each index's day is cut into moves (a reversal of at least
 *    max(0.25%, 1.5 × ATR) on the 5-minute closes); a move runs bottom → top (UP) or top → bottom;
 *  - for every move: the best strike to have held (entry / closing premium), the key candles where
 *    the premium jumped or fell, and which indicators pointed the right way at the start, how many,
 *    and how many candles ahead;
 *  - an indicator scorecard over all candles: hit rate of each indicator's signal over the next
 *    3 candles (15 min), the average move, ₹ per lot of the ATM option, moves it caught, lead time,
 *    and where it works best (time of day, trend / sideways, index);
 *  - how often the move follows when N indicators agree, the best pairs, and suggested weights for
 *    the scoring engine's 10 factors — only with enough data, learnt on older days and tested on
 *    newer ones. Suggestions only: nothing is changed automatically.
 */
import { FACTOR_LABELS } from '../engine/types.ts';
import { FACTORS, istDay, type CandleRecord } from './recorder.ts';

export type Sig = -1 | 0 | 1;
const CANDLE_MS = 5 * 60_000;
/** Forward window for hit rates (candles) and the smallest move that counts (fraction of price). */
export const HORIZON = 3;
const MIN_MOVE = 0.0002;
/** Minimum samples before a number is trusted / a suggestion is made. */
export const MIN_SIGNALS = 30;
export const MIN_MOVES_FOR_WEIGHTS = 30;
export const MIN_DAYS_FOR_WEIGHTS = 5;

export interface IndicatorDef {
  key: string;
  label: string;
  /** Index into FACTORS for the scoring engine's own factors. */
  factor?: number;
  signal: (r: CandleRecord, confHigh: number) => Sig;
}

const sgn = (n: number): Sig => (n > 0 ? 1 : n < 0 ? -1 : 0);

export const INDICATORS: IndicatorDef[] = [
  ...FACTORS.map(
    (k, i): IndicatorDef => ({
      key: k,
      label: FACTOR_LABELS[k][0],
      factor: i,
      // The factor favours the side it gives more points to.
      signal: (r) => (r.fCE && r.fPE ? sgn(r.fCE[i] - r.fPE[i]) : 0),
    }),
  ),
  { key: 'rsiMomentum', label: 'RSI momentum (>55 up / <45 down)', signal: (r) => (r.ind.rsi > 55 ? 1 : r.ind.rsi < 45 ? -1 : 0) },
  { key: 'rsiReversal', label: 'RSI reversal (<30 up / >70 down)', signal: (r) => (r.ind.rsi < 30 ? 1 : r.ind.rsi > 70 ? -1 : 0) },
  { key: 'adxDi', label: 'ADX ≥ 20 with +DI / −DI', signal: (r) => (r.ind.adx >= 20 ? sgn(r.ind.pdi - r.ind.mdi) : 0) },
  { key: 'priceVwap', label: 'Price vs VWAP (candle)', signal: (r) => sgn(r.c - r.ind.vwap) },
  { key: 'engineLean', label: 'Engine lean (score CE vs PE)', signal: (r) => sgn(r.sCE - r.sPE) },
  { key: 'engineSignal', label: 'Engine signal (score ≥ trade level)', signal: (r, hi) => (r.conf >= hi ? (r.dir === 'CE' ? 1 : r.dir === 'PE' ? -1 : 0) : 0) },
];

/** Records grouped per index per day, in time order. */
export function sequences(records: CandleRecord[]): CandleRecord[][] {
  const m = new Map<string, CandleRecord[]>();
  for (const r of records) {
    const k = `${r.s}|${istDay(r.t)}`;
    (m.get(k) ?? m.set(k, []).get(k)!).push(r);
  }
  return [...m.values()].map((s) => s.sort((a, b) => a.t - b.t));
}

/** Index of the record HORIZON candles later (no gap in the recording), or -1. */
function ahead(seq: CandleRecord[], i: number, h = HORIZON): number {
  const j = i + h;
  return j < seq.length && seq[j].t - seq[i].t <= h * CANDLE_MS + 60_000 ? j : -1;
}

const premOf = (r: CandleRecord, strike: number | string, side: 0 | 1) => r.prem[String(strike)]?.[side] ?? 0;

// ---------------------------------------------------------------- moves (tops and bottoms)

export interface OptionLeg {
  side: 'CE' | 'PE';
  strike: number;
  entry: number;
  exit: number;
  gainPct: number;
  perLot: number;
}

export interface KeyCandle {
  t: number;
  from: number;
  to: number;
  changePct: number;
  /** Indicators agreeing with the move at that candle. */
  agree: number;
}

export interface MoveReport {
  s: string;
  day: string;
  dir: 'UP' | 'DOWN';
  /** Bottom (UP) / top (DOWN) where the move started, and where it ended. */
  start: { t: number; price: number };
  end: { t: number; price: number };
  pts: number;
  pct: number;
  candles: number;
  /** The move is still running at the last record of the day. */
  open: boolean;
  best: OptionLeg | null;
  atmLeg: OptionLeg | null;
  keyCandles: KeyCandle[];
  /** Indicators that pointed the move's way at its start (or up to 3 candles before), and how early. */
  predicted: { key: string; label: string; lead: number }[];
  total: number;
}

/** Bottom / top pivots of one index-day (zig-zag on closes). */
export function findMoves(seq: CandleRecord[]): { from: number; to: number; open: boolean }[] {
  const n = seq.length;
  if (n < 3) return [];
  const th = (i: number) => Math.max(seq[i].c * 0.0025, 1.5 * (seq[i].ind.atr || 0));
  const out: { from: number; to: number; open: boolean }[] = [];
  let dir = 0;
  let pivot = 0;
  let ext = 0;
  let hi = 0;
  let lo = 0;
  for (let i = 1; i < n; i++) {
    const c = seq[i].c;
    if (dir === 0) {
      if (c > seq[hi].c) hi = i;
      if (c < seq[lo].c) lo = i;
      if (c - seq[lo].c >= th(lo) && lo < i) {
        pivot = lo;
        dir = 1;
        ext = i;
      } else if (seq[hi].c - c >= th(hi) && hi < i) {
        pivot = hi;
        dir = -1;
        ext = i;
      }
      continue;
    }
    if (dir === 1) {
      if (c >= seq[ext].c) ext = i;
      else if (seq[ext].c - c >= th(ext)) {
        out.push({ from: pivot, to: ext, open: false });
        pivot = ext;
        dir = -1;
        ext = i;
      }
    } else {
      if (c <= seq[ext].c) ext = i;
      else if (c - seq[ext].c >= th(ext)) {
        out.push({ from: pivot, to: ext, open: false });
        pivot = ext;
        dir = 1;
        ext = i;
      }
    }
  }
  if (dir !== 0 && Math.abs(seq[ext].c - seq[pivot].c) >= th(pivot)) out.push({ from: pivot, to: ext, open: ext === n - 1 });
  return out;
}

function leg(start: CandleRecord, end: CandleRecord, strike: number, side: 0 | 1): OptionLeg | null {
  const a = premOf(start, strike, side);
  const b = premOf(end, strike, side);
  if (!(a > 0 && b > 0)) return null;
  return { side: side === 0 ? 'CE' : 'PE', strike, entry: a, exit: b, gainPct: (100 * (b - a)) / a, perLot: (b - a) * (start.lot || 0) };
}

export function analyseMove(seq: CandleRecord[], m: { from: number; to: number; open: boolean }, confHigh: number): MoveReport {
  const s0 = seq[m.from];
  const e0 = seq[m.to];
  const up = e0.c > s0.c;
  const want: Sig = up ? 1 : -1;
  const side: 0 | 1 = up ? 0 : 1;
  let best: OptionLeg | null = null;
  for (const k of Object.keys(s0.prem)) {
    const l = leg(s0, e0, Number(k), side);
    if (l && (!best || l.gainPct > best.gainPct)) best = l;
  }
  const atmLeg = leg(s0, e0, s0.atm, side);
  const agreeAt = (r: CandleRecord) => INDICATORS.filter((d) => d.signal(r, confHigh) === want).length;
  const keyCandles: KeyCandle[] = [];
  if (best) {
    for (let i = m.from + 1; i <= m.to; i++) {
      const a = premOf(seq[i - 1], best.strike, side);
      const b = premOf(seq[i], best.strike, side);
      if (a > 0 && b > 0) keyCandles.push({ t: seq[i].t, from: a, to: b, changePct: (100 * (b - a)) / a, agree: agreeAt(seq[i - 1]) });
    }
    keyCandles.sort((x, y) => Math.abs(y.changePct) - Math.abs(x.changePct));
    keyCandles.splice(3);
  }
  const predicted: MoveReport['predicted'] = [];
  for (const d of INDICATORS) {
    let earliest = -1;
    for (let j = Math.max(0, m.from - 6); j <= m.from; j++) {
      if (d.signal(seq[j], confHigh) === want) {
        if (earliest < 0) earliest = j;
      } else earliest = -1; // must still agree up to the start
    }
    // Pointed the right way at the start, or in the 3 candles just before it.
    const near = earliest >= 0 || [1, 2, 3].some((k) => m.from - k >= 0 && d.signal(seq[m.from - k], confHigh) === want);
    if (near) predicted.push({ key: d.key, label: d.label, lead: earliest >= 0 ? m.from - earliest : 0 });
  }
  return {
    s: s0.s,
    day: istDay(s0.t),
    dir: up ? 'UP' : 'DOWN',
    start: { t: s0.t, price: s0.c },
    end: { t: e0.t, price: e0.c },
    pts: e0.c - s0.c,
    pct: (100 * (e0.c - s0.c)) / s0.c,
    candles: m.to - m.from,
    open: m.open,
    best,
    atmLeg,
    keyCandles,
    predicted,
    total: INDICATORS.length,
  };
}

// ---------------------------------------------------------------- scorecard

interface Tally {
  n: number;
  hits: number;
}
const rate = (t: Tally) => (t.n ? (100 * t.hits) / t.n : null);

export interface IndicatorScore {
  key: string;
  label: string;
  factor?: number;
  signals: number;
  hitRate: number | null;
  /** Average index move in the signal's direction over the next 3 candles (points). */
  avgPts: number | null;
  /** Average ₹ per lot of the ATM option on the signal's side over the next 3 candles. */
  perLot: number | null;
  /** Share of the marked moves it pointed to at the start (or up to 3 candles before), and how early. */
  caughtPct: number | null;
  avgLead: number | null;
  best: { label: string; hitRate: number; n: number } | null;
  bySymbol: Record<string, { n: number; hitRate: number | null }>;
  enough: boolean;
}

const bucketsOf = (r: CandleRecord): string[] => {
  const d = new Date(r.t + 5.5 * 3600_000);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  const time = m < 10 * 60 + 30 ? 'Opening (9:15–10:30)' : m < 13 * 60 ? 'Midday (10:30–13:00)' : 'Afternoon (13:00–15:30)';
  return [time, r.ind.adx >= 20 ? 'Trending (ADX ≥ 20)' : 'Sideways (ADX < 20)'];
};

function outcome(seq: CandleRecord[], i: number, s: Sig): { hit: boolean; pts: number; perLot: number | null } | null {
  const j = ahead(seq, i);
  if (j < 0 || s === 0) return null;
  const a = seq[i];
  const b = seq[j];
  const fwd = b.c - a.c;
  const hit = Math.sign(fwd) === s && Math.abs(fwd) / a.c >= MIN_MOVE;
  const side: 0 | 1 = s > 0 ? 0 : 1;
  const p0 = premOf(a, a.atm, side);
  const p1 = premOf(b, a.atm, side);
  return { hit, pts: s * fwd, perLot: p0 > 0 && p1 > 0 ? (p1 - p0) * (a.lot || 0) : null };
}

export function scorecard(seqs: CandleRecord[][], moves: MoveReport[], confHigh: number): IndicatorScore[] {
  return INDICATORS.map((d) => {
    const all: Tally = { n: 0, hits: 0 };
    let pts = 0;
    let lot = 0;
    let lotN = 0;
    const buckets = new Map<string, Tally>();
    const sym = new Map<string, Tally>();
    for (const seq of seqs) {
      for (let i = 0; i < seq.length; i++) {
        const o = outcome(seq, i, d.signal(seq[i], confHigh));
        if (!o) continue;
        all.n++;
        if (o.hit) all.hits++;
        pts += o.pts;
        if (o.perLot != null) {
          lot += o.perLot;
          lotN++;
        }
        for (const b of [...bucketsOf(seq[i]), `Index ${seq[i].s}`]) {
          const t = buckets.get(b) ?? { n: 0, hits: 0 };
          t.n++;
          if (o.hit) t.hits++;
          buckets.set(b, t);
        }
        const t = sym.get(seq[i].s) ?? { n: 0, hits: 0 };
        t.n++;
        if (o.hit) t.hits++;
        sym.set(seq[i].s, t);
      }
    }
    const caught = moves.map((m) => m.predicted.find((p) => p.key === d.key));
    const hitMoves = caught.filter(Boolean) as { lead: number }[];
    let best: IndicatorScore['best'] = null;
    for (const [label, t] of buckets)
      if (t.n >= MIN_SIGNALS / 2 && (!best || rate(t)! > best.hitRate)) best = { label, hitRate: rate(t)!, n: t.n };
    return {
      key: d.key,
      label: d.label,
      factor: d.factor,
      signals: all.n,
      hitRate: rate(all),
      avgPts: all.n ? pts / all.n : null,
      perLot: lotN ? lot / lotN : null,
      caughtPct: moves.length ? (100 * hitMoves.length) / moves.length : null,
      avgLead: hitMoves.length ? hitMoves.reduce((s, x) => s + x.lead, 0) / hitMoves.length : null,
      best,
      bySymbol: Object.fromEntries([...sym].map(([k, t]) => [k, { n: t.n, hitRate: rate(t) }])),
      enough: all.n >= MIN_SIGNALS,
    };
  });
}

/** How often the move follows when N indicators agree (the larger side of up / down votes). */
export function agreement(seqs: CandleRecord[][], confHigh: number): { agree: number; n: number; hitRate: number | null }[] {
  const by = new Map<number, Tally>();
  for (const seq of seqs)
    for (let i = 0; i < seq.length; i++) {
      let up = 0;
      let dn = 0;
      for (const d of INDICATORS) {
        const s = d.signal(seq[i], confHigh);
        if (s > 0) up++;
        else if (s < 0) dn++;
      }
      if (up === dn) continue;
      const o = outcome(seq, i, up > dn ? 1 : -1);
      if (!o) continue;
      const k = Math.max(up, dn);
      const t = by.get(k) ?? { n: 0, hits: 0 };
      t.n++;
      if (o.hit) t.hits++;
      by.set(k, t);
    }
  return [...by].sort((a, b) => a[0] - b[0]).map(([agree, t]) => ({ agree, n: t.n, hitRate: rate(t) }));
}

/** The best pairs of indicators (both pointing the same way), with enough samples. */
export function combos(seqs: CandleRecord[][], confHigh: number, top = 5): { a: string; b: string; n: number; hitRate: number }[] {
  const K = INDICATORS.length;
  const t: Tally[] = Array.from({ length: K * K }, () => ({ n: 0, hits: 0 }));
  for (const seq of seqs)
    for (let i = 0; i < seq.length; i++) {
      const s = INDICATORS.map((d) => d.signal(seq[i], confHigh));
      const fwd = ahead(seq, i);
      if (fwd < 0) continue;
      const mv = seq[fwd].c - seq[i].c;
      const big = Math.abs(mv) / seq[i].c >= MIN_MOVE;
      for (let a = 0; a < K; a++) {
        if (!s[a]) continue;
        for (let b = a + 1; b < K; b++) {
          if (s[b] !== s[a]) continue;
          const x = t[a * K + b];
          x.n++;
          if (big && Math.sign(mv) === s[a]) x.hits++;
        }
      }
    }
  const out: { a: string; b: string; n: number; hitRate: number }[] = [];
  for (let a = 0; a < K; a++)
    for (let b = a + 1; b < K; b++) {
      const x = t[a * K + b];
      if (x.n >= MIN_SIGNALS) out.push({ a: INDICATORS[a].label, b: INDICATORS[b].label, n: x.n, hitRate: rate(x)! });
    }
  return out.sort((x, y) => y.hitRate - x.hitRate).slice(0, top);
}

// ---------------------------------------------------------------- weight suggestions

export type WeightAdvice =
  | { ready: false; reason: string }
  | {
      ready: true;
      factors: { key: string; label: string; current: number; suggested: number; trainHit: number | null }[];
      trainDays: number;
      testDays: number;
      /** Direction accuracy on the test days (higher score side vs the next 3 candles). */
      currentAcc: number;
      suggestedAcc: number;
      tested: number;
      better: boolean;
    };

export function suggestWeights(records: CandleRecord[], moveCount: number): WeightAdvice {
  const days = [...new Set(records.map((r) => istDay(r.t)))].sort();
  if (days.length < MIN_DAYS_FOR_WEIGHTS)
    return { ready: false, reason: `Needs at least ${MIN_DAYS_FOR_WEIGHTS} recorded days (now ${days.length}).` };
  if (moveCount < MIN_MOVES_FOR_WEIGHTS)
    return { ready: false, reason: `Needs at least ${MIN_MOVES_FOR_WEIGHTS} marked moves (now ${moveCount}).` };
  const cut = Math.max(1, Math.min(days.length - 2, Math.round(days.length * 0.7)));
  const trainDays = new Set(days.slice(0, cut));
  const train = sequences(records.filter((r) => trainDays.has(istDay(r.t))));
  const test = sequences(records.filter((r) => !trainDays.has(istDay(r.t))));
  const max = FACTORS.map((k) => FACTOR_LABELS[k][1]);
  const hits = FACTORS.map((_, i) => {
    const t: Tally = { n: 0, hits: 0 };
    for (const seq of train)
      for (let j = 0; j < seq.length; j++) {
        const o = outcome(seq, j, INDICATORS[i].signal(seq[j], 0));
        if (!o) continue;
        t.n++;
        if (o.hit) t.hits++;
      }
    return t.n >= MIN_SIGNALS / 2 ? rate(t) : null;
  });
  const edge = hits.map((h) => (h == null ? 0 : Math.max(0, h - 50)));
  const sum = edge.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return { ready: false, reason: 'No factor beat a coin flip on the older days — no weights to suggest yet.' };
  const total = max.reduce((a, b) => a + b, 0);
  const suggested = edge.map((e) => Math.round((total * e) / sum));
  let tested = 0;
  let cur = 0;
  let sug = 0;
  for (const seq of test)
    for (let j = 0; j < seq.length; j++) {
      const r = seq[j];
      if (!r.fCE || !r.fPE) continue;
      const k = ahead(seq, j);
      if (k < 0) continue;
      const mv = seq[k].c - r.c;
      if (Math.abs(mv) / r.c < MIN_MOVE) continue;
      const diff = FACTORS.map((_, i) => r.fCE![i] - r.fPE![i]);
      const a = Math.sign(diff.reduce((x, y) => x + y, 0));
      const b = Math.sign(diff.reduce((x, y, i) => x + (suggested[i] * y) / (max[i] || 1), 0));
      if (!a && !b) continue;
      tested++;
      if (a === Math.sign(mv)) cur++;
      if (b === Math.sign(mv)) sug++;
    }
  if (tested < MIN_SIGNALS) return { ready: false, reason: `Not enough test candles on the newer days (${tested}).` };
  const currentAcc = (100 * cur) / tested;
  const suggestedAcc = (100 * sug) / tested;
  return {
    ready: true,
    factors: FACTORS.map((k, i) => ({ key: k, label: FACTOR_LABELS[k][0], current: max[i], suggested: suggested[i], trainHit: hits[i] })),
    trainDays: trainDays.size,
    testDays: days.length - trainDays.size,
    currentAcc,
    suggestedAcc,
    tested,
    better: suggestedAcc >= currentAcc + 2,
  };
}

// ---------------------------------------------------------------- everything, and export

export interface MemoryReport {
  days: string[];
  records: number;
  symbols: string[];
  moves: MoveReport[];
  scorecard: IndicatorScore[];
  agreement: ReturnType<typeof agreement>;
  combos: ReturnType<typeof combos>;
  weights: WeightAdvice;
}

export function analyse(records: CandleRecord[], o: { confHigh: number; symbol?: string | null }): MemoryReport {
  const recs = o.symbol ? records.filter((r) => r.s === o.symbol) : records;
  const seqs = sequences(recs);
  const moves = seqs.flatMap((seq) => findMoves(seq).map((m) => analyseMove(seq, m, o.confHigh)));
  moves.sort((a, b) => b.start.t - a.start.t);
  const closed = moves.filter((m) => !m.open);
  const sc = scorecard(seqs, closed, o.confHigh).sort((a, b) => (b.enough ? 1 : 0) - (a.enough ? 1 : 0) || (b.hitRate ?? -1) - (a.hitRate ?? -1));
  return {
    days: [...new Set(recs.map((r) => istDay(r.t)))].sort(),
    records: recs.length,
    symbols: [...new Set(records.map((r) => r.s))].sort(),
    moves,
    scorecard: sc,
    agreement: agreement(seqs, o.confHigh),
    combos: combos(seqs, o.confHigh),
    weights: suggestWeights(recs, closed.length),
  };
}

const ist = (t: number) => new Date(t + 5.5 * 3600_000).toISOString().replace('T', ' ').slice(0, 16);
const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Every recorded candle as CSV (one row per candle; factor and premium columns flattened). */
export function recordsCsv(records: CandleRecord[]): string {
  const strikes = 7;
  const head = [
    'index', 'time_ist', 'open', 'high', 'low', 'close', 'ema20', 'ema50', 'vwap', 'rsi', 'adx', 'plus_di', 'minus_di', 'atr',
    'spot', 'pcr', 'iv', 'iv_pct', 'direction', 'confidence', 'score_ce', 'score_pe',
    ...FACTORS.map((k) => `ce_${k}`), ...FACTORS.map((k) => `pe_${k}`), 'atm', 'lot',
    ...Array.from({ length: strikes }, (_, i) => [`strike_${i - 3}`, `ce_${i - 3}`, `pe_${i - 3}`]).flat(),
  ];
  const rows = records.map((r) => {
    const ks = Object.keys(r.prem).map(Number).sort((a, b) => a - b);
    const ai = ks.indexOf(r.atm);
    const around = Array.from({ length: strikes }, (_, i) => {
      const k = ks[ai + i - 3];
      return k == null ? ['', '', ''] : [k, r.prem[String(k)][0], r.prem[String(k)][1]];
    }).flat();
    return [
      r.s, ist(r.t), r.o, r.h, r.l, r.c, r.ind.ema20, r.ind.ema50, r.ind.vwap, r.ind.rsi, r.ind.adx, r.ind.pdi, r.ind.mdi, r.ind.atr,
      r.spot, r.pcr, r.iv, r.ivp ?? '', r.dir, r.conf, r.sCE, r.sPE,
      ...(r.fCE ?? FACTORS.map(() => '')), ...(r.fPE ?? FACTORS.map(() => '')), r.atm, r.lot, ...around,
    ];
  });
  return [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}

/** The marked moves as CSV. */
export function movesCsv(moves: MoveReport[]): string {
  const head = ['index', 'day', 'direction', 'start_ist', 'start_price', 'end_ist', 'end_price', 'points', 'pct', 'candles', 'open',
    'best_strike', 'best_side', 'best_entry', 'best_exit', 'best_gain_pct', 'best_per_lot', 'atm_entry', 'atm_exit',
    'predicted_count', 'indicators', 'predicted_by'];
  const rows = moves.map((m) => [
    m.s, m.day, m.dir, ist(m.start.t), m.start.price, ist(m.end.t), m.end.price, m.pts.toFixed(2), m.pct.toFixed(3), m.candles, m.open,
    m.best?.strike ?? '', m.best?.side ?? '', m.best?.entry ?? '', m.best?.exit ?? '', m.best?.gainPct.toFixed(1) ?? '', m.best?.perLot.toFixed(0) ?? '',
    m.atmLeg?.entry ?? '', m.atmLeg?.exit ?? '', m.predicted.length, m.total, m.predicted.map((p) => `${p.key}(${p.lead})`).join(' '),
  ]);
  return [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}
