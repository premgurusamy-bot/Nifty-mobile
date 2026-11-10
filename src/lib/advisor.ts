/**
 * Voice advisor: looks at every watched index (score, signal, the setup, the trend, entry strength,
 * the gap, a trade) and says which is BEST to watch now, which to WATCH, which to SKIP — and what
 * happens next for each. Pure: the app speaks `speech` (expo-speech) when it changes.
 */
import { breadthFit, type Breadth } from './breadth.ts';
import type { EntryStrength, TrendReport } from './engine/trend.ts';

export type AdviceVerdict = 'IN TRADE' | 'BEST' | 'WATCH' | 'SKIP' | 'OFF';

export interface IndexInput {
  symbol: string;
  label: string;
  confidence: number | null;
  signal: string;
  direction: string;
  strike: number;
  decision: string;
  inTrade: boolean;
  tradePnl?: number | null;
  off?: boolean;
  paused?: boolean;
  error?: string;
  trend?: (TrendReport & { entry?: EntryStrength | null }) | null;
  /** The selected option's IV (%) and the index's IV percentile (−1 / null = not enough history yet). */
  iv?: number | null;
  ivPercentile?: number | null;
  /** The selected option's traded volume, and the median of the strikes around the money (same units). */
  volume?: { leg: number; median: number } | null;
  /** Advances / declines of the index's stocks. */
  breadth?: Breadth | null;
}

export type IvLevel = 'LOW' | 'NORMAL' | 'HIGH' | 'UNKNOWN';
export type VolumeLevel = 'HEAVY' | 'NORMAL' | 'THIN' | 'UNKNOWN';

/** IV level from the percentile: under 30 low (cheap premiums), over 70 high (dear, IV-drop risk). */
export function ivLevel(ivPercentile: number | null | undefined): IvLevel {
  if (ivPercentile == null || ivPercentile < 0) return 'UNKNOWN';
  return ivPercentile < 30 ? 'LOW' : ivPercentile > 70 ? 'HIGH' : 'NORMAL';
}

/** Volume of the option against the strikes around it: thin options fill badly. */
export function volumeLevel(v: { leg: number; median: number } | null | undefined): { level: VolumeLevel; ratio: number | null } {
  if (!v || !(v.median > 0)) return { level: 'UNKNOWN', ratio: null };
  const ratio = v.leg / v.median;
  return { level: ratio >= 1.5 ? 'HEAVY' : ratio >= 0.5 ? 'NORMAL' : 'THIN', ratio };
}

export interface IndexAdvice {
  symbol: string;
  label: string;
  verdict: AdviceVerdict;
  /** Why (short). */
  reason: string;
  /** What happens next / what to look for. */
  next: string;
  rank: number;
  /** "IV 13.2 · low (22 pct)" and "volume heavy (1.8× nearby strikes)" for the screen. */
  ivText: string;
  volText: string;
  /** "Nifty 50 stocks: 38 up, 12 down · weighted +0.42%" (empty when not known). */
  breadthText: string;
  iv: IvLevel;
  vol: VolumeLevel;
}

export interface Advice {
  best: string | null;
  items: IndexAdvice[];
  /** One line for the screen. */
  headline: string;
  /** What the app says. */
  speech: string;
  /** Changes only when the advice really changes (best index or a verdict) — speak again then. */
  key: string;
}

/** Index names as they are spoken. */
const spoken = (label: string) => label.replace(/NIFTY 50/i, 'Nifty').replace(/BANK NIFTY/i, 'Bank Nifty').replace(/FIN NIFTY/i, 'Fin Nifty');
const dur = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} hour ${m % 60} minutes` : `${m} minutes`);
const round = (n: number) => Math.round(n).toLocaleString('en-IN');

export function advise(inputs: IndexInput[], cfg: { confHigh: number; confWatch: number }): Advice {
  const items: IndexAdvice[] = inputs.map((x): IndexAdvice => {
    const ivl = ivLevel(x.ivPercentile);
    const vl = volumeLevel(x.volume);
    const ivText =
      x.iv != null && x.iv > 0
        ? `IV ${x.iv.toFixed(1)} · ${ivl === 'UNKNOWN' ? 'level not known yet' : `${ivl.toLowerCase()} (${x.ivPercentile!.toFixed(0)} percentile)`}`
        : 'IV —';
    const volText =
      vl.level === 'UNKNOWN' ? 'volume —' : `volume ${vl.level.toLowerCase()} (${vl.ratio!.toFixed(1)}× nearby strikes)`;
    const extra = { ivText, volText, breadthText: x.breadth?.text ?? '', iv: ivl, vol: vl.level };
    const r = adviseOne(x);
    return { ...r, ...extra };
  });

  function adviseOne(x: IndexInput): Omit<IndexAdvice, 'ivText' | 'volText' | 'breadthText' | 'iv' | 'vol'> {
    const t = x.trend ?? null;
    const conf = x.confidence ?? 0;
    const side = x.direction === 'CE' || x.direction === 'LONG' ? 'up' : 'down';
    const trendWord = t
      ? t.direction === 'SIDEWAYS'
        ? 'no trend'
        : `${t.direction === 'UP' ? 'up' : 'down'} trend for ${dur(t.ageMin)}`
      : 'trend not known yet';
    const base = { symbol: x.symbol, label: x.label };
    if (x.off) return { ...base, verdict: 'OFF', reason: 'switched off', next: '', rank: -1 };
    if (x.inTrade) {
      const pnl = x.tradePnl == null ? '' : `, ${x.tradePnl >= 0 ? 'profit' : 'loss'} ${round(Math.abs(x.tradePnl))} rupees`;
      const end = t && (t.phase === 'EXHAUSTING' || t.phase === 'REVERSING') ? ' The trend is tiring: be ready to exit.' : '';
      return { ...base, verdict: 'IN TRADE', reason: `in a ${x.direction} trade${pnl}`, next: `Managing the trade.${end}`, rank: 1000 };
    }
    if (x.error) return { ...base, verdict: 'SKIP', reason: 'no data', next: 'Waiting for data.', rank: -1 };
    if (x.paused) return { ...base, verdict: 'SKIP', reason: 'paused, data was slow', next: '', rank: -1 };
    // Trend first: the trend is your friend.
    if (t && t.direction === 'SIDEWAYS')
      return { ...base, verdict: 'SKIP', reason: `no trend, sideways`, next: 'Wait for a trend to form.', rank: conf * 0.2 };
    if (t && (t.phase === 'REVERSING' || t.phase === 'EXHAUSTING'))
      return {
        ...base,
        verdict: 'SKIP',
        reason: `the ${t.direction === 'UP' ? 'up' : 'down'} trend is ${t.phase === 'REVERSING' ? 'breaking' : 'tiring'}`,
        next: 'Wait for a new trend.',
        rank: conf * 0.3,
      };
    if (t && x.direction && ((t.direction === 'UP') !== (side === 'up')))
      return {
        ...base,
        verdict: 'SKIP',
        reason: `the setup is against the ${t.direction === 'UP' ? 'up' : 'down'} trend`,
        next: `Wait for a ${t.direction === 'UP' ? 'CE' : 'PE'} setup.`,
        rank: conf * 0.3,
      };
    if (/^BLOCKED/.test(x.decision)) {
      const why = x.decision.replace(/^BLOCKED - /, '').replace(/ —.*$/, '');
      return { ...base, verdict: 'SKIP', reason: why, next: '', rank: conf * 0.2 };
    }
    if (conf < cfg.confWatch)
      return { ...base, verdict: 'SKIP', reason: `score only ${conf.toFixed(0)}`, next: `Needs ${cfg.confHigh} to trade.`, rank: conf * 0.5 };
    // Volume: an option hardly anyone trades fills badly — skip it.
    const vl = volumeLevel(x.volume);
    if (vl.level === 'THIN' && vl.ratio != null && vl.ratio < 0.25)
      return { ...base, verdict: 'SKIP', reason: `volume very thin on ${x.direction} ${x.strike}`, next: 'Poor fills: wait for volume.', rank: conf * 0.3 };
    // Breadth: most of the index's stocks going the other way — the move has little behind it.
    const bf = x.direction ? breadthFit(x.breadth, side) : breadthFit(null, side);
    if (bf.fit === 'STRONG AGAINST')
      return {
        ...base,
        verdict: 'SKIP',
        reason: `${bf.words}, against the ${x.direction} setup`,
        next: 'Wait until breadth turns.',
        rank: conf * 0.3,
      };
    // Worth watching: what comes next.
    const entry = t?.entry?.score ?? null;
    const ivl = ivLevel(x.ivPercentile);
    // Cheap IV and heavy volume help an option buyer; dear IV and thin volume hurt.
    const rank =
      conf +
      (t ? t.strength * 0.3 : 0) +
      (entry != null ? entry * 0.2 : 0) +
      (ivl === 'LOW' ? 5 : ivl === 'HIGH' ? -10 : 0) +
      (vl.level === 'HEAVY' ? 5 : vl.level === 'THIN' ? -10 : 0) +
      (bf.fit === 'WITH' ? 5 : bf.fit === 'AGAINST' ? -10 : 0);
    let next: string;
    const trig = /break of ([\d,.]+)/.exec(x.decision)?.[1];
    if (/^SETUP (ARMED|HOLDING)/.test(x.decision))
      next = `Setup armed: ${x.direction} ${x.strike} enters if price breaks ${trig ?? 'the trigger'} after the hold.`;
    else if (/^SETUP PENDING/.test(x.decision)) next = `Hold done: ${x.direction} ${x.strike} enters when price breaks ${trig ?? 'the trigger'}.`;
    else if (/^SETUP FADING/.test(x.decision)) next = 'The score is fading: hold restarted.';
    else if (/^SIGNAL CONFIRMED|^TRADE/.test(x.decision)) next = `Signal confirmed: ${x.direction} ${x.strike}.`;
    else if (conf < cfg.confHigh) next = `Score ${conf.toFixed(0)}, building towards ${cfg.confHigh}.`;
    else next = 'At the trade level: waiting for the setup.';
    const strength = entry != null ? `, entry strength ${entry.toFixed(0)}` : '';
    const ivWord = ivl === 'LOW' ? ', IV low' : ivl === 'HIGH' ? ', IV high, premiums dear' : '';
    const volWord = vl.level === 'HEAVY' ? ', volume heavy' : vl.level === 'THIN' ? ', volume thin' : '';
    const brWord = bf.words ? `, ${bf.words}${bf.fit === 'AGAINST' ? ', not with the setup' : ''}` : '';
    return { ...base, verdict: 'WATCH', reason: `score ${conf.toFixed(0)}, ${trendWord}${strength}${ivWord}${volWord}${brWord}`, next, rank };
  }

  // The best: a trade first, else the highest-ranked index worth watching.
  const candidates = items.filter((i) => i.verdict === 'WATCH').sort((a, b) => b.rank - a.rank);
  const trade = items.find((i) => i.verdict === 'IN TRADE');
  const bestItem = trade ?? candidates[0] ?? null;
  if (bestItem && bestItem.verdict === 'WATCH') bestItem.verdict = 'BEST';
  const order: Record<AdviceVerdict, number> = { 'IN TRADE': 0, BEST: 1, WATCH: 2, SKIP: 3, OFF: 4 };
  items.sort((a, b) => order[a.verdict] - order[b.verdict] || b.rank - a.rank);

  const live = items.filter((i) => i.verdict !== 'OFF');
  const headline = bestItem
    ? bestItem.verdict === 'IN TRADE'
      ? `${bestItem.label}: in trade`
      : `Best: ${bestItem.label} — ${bestItem.reason}`
    : live.length
      ? 'Nothing to trade now — all indexes skipped'
      : 'All indexes are off';
  const parts: string[] = [];
  if (bestItem && bestItem.verdict === 'BEST') parts.push(`Best index: ${spoken(bestItem.label)}. ${bestItem.reason}. ${bestItem.next}`);
  for (const i of items) {
    if (i === bestItem && i.verdict === 'BEST') continue;
    if (i.verdict === 'OFF') continue;
    if (i.verdict === 'IN TRADE') parts.push(`${spoken(i.label)}: ${i.reason}. ${i.next}`);
    else parts.push(`${spoken(i.label)}: ${i.verdict === 'WATCH' ? 'watch' : 'skip'}, ${i.reason}.${i.verdict === 'WATCH' && i.next ? ` ${i.next}` : ''}`);
  }
  if (!bestItem && live.length) parts.unshift('No index to trade right now.');
  const speech = parts.join(' ').replace(/\s+/g, ' ').trim();
  const key = `${bestItem?.symbol ?? '-'}|${items.map((i) => `${i.symbol}:${i.verdict}`).join(',')}`;
  return { best: bestItem?.symbol ?? null, items, headline, speech, key };
}
