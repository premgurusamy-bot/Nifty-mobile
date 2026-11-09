/**
 * Voice advisor: looks at every watched index (score, signal, the setup, the trend, entry strength,
 * the gap, a trade) and says which is BEST to watch now, which to WATCH, which to SKIP — and what
 * happens next for each. Pure: the app speaks `speech` (expo-speech) when it changes.
 */
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
  const items: IndexAdvice[] = inputs.map((x) => {
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
    // Worth watching: what comes next.
    const entry = t?.entry?.score ?? null;
    const rank = conf + (t ? t.strength * 0.3 : 0) + (entry != null ? entry * 0.2 : 0);
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
    return { ...base, verdict: 'WATCH', reason: `score ${conf.toFixed(0)}, ${trendWord}${strength}`, next, rank };
  });

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
