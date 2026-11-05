/**
 * Index screener: runs the app's own engine on each index's live data and adds a
 * "what is the market doing today" read, so you can pick the index (and side) that
 * suits right now — and see the risks before entering at market.
 *
 * Everything comes from prices, OI and IV. There is no news / events feed.
 */
import { formatINR } from './format.ts';
import { entryCutoff, istDate, pastEntryCutoff, runCycle } from './engine/decision.ts';
import { istDay } from './engine/indicators.ts';
import { catalogEntry, sessionOpen } from './engine/catalog.ts';
import {
  initialEngineState,
  type Candle,
  type ChainSnapshot,
  type Dashboard,
  type EngineConfig,
  type TradePlan,
} from './engine/types.ts';

export const SCREEN_INDEXES = ['NIFTY', 'BANKNIFTY', 'FINNIFTY'] as const;

export type Verdict = 'GOOD' | 'CAUTION' | 'AVOID' | 'NO NEW TRADES';

export interface DayStats {
  open: number;
  high: number;
  low: number;
  last: number;
  prevClose: number | null;
  changePct: number | null;
  gapPct: number | null;
  /** Today's high–low so far vs the average full-day range of the previous sessions. */
  rangePts: number;
  avgRangePts: number | null;
  rangeUsed: number | null;
  /** 0 = pure chop, 1 = straight line (last 12 five-minute candles). */
  efficiency: number;
  /** Where price sits in today's range (0 = low, 1 = high). */
  rangePos: number;
  vwapDistPct: number;
  atrPct: number;
  lastCandleAgeMin: number;
}

export interface ScreenResult {
  symbol: string;
  label: string;
  verdict: Verdict;
  /** 0–100 suitability for a trade now. */
  score: number;
  direction: 'CE' | 'PE';
  confidence: number;
  signal: string;
  decision: string;
  trend: string;
  pattern: string;
  pcr: number;
  iv: number;
  ivPercentile: number;
  expiry: string;
  expiryDay: boolean;
  daysToExpiry: number;
  spot: number;
  day: DayStats;
  /** What ENTER at market would trade now (null when nothing can be priced). */
  plan: TradePlan | null;
  /** Short reasons that raise the score. */
  pros: string[];
  /** Risks and reasons that lower it. */
  warnings: string[];
  /** One-line "what is going on today". */
  summary: string;
}

const ist = (ms: number) => new Date(ms + 5.5 * 3600_000);
const pct = (n: number, d = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`;
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

export function dayStats(candles: Candle[], vwap: number, atr: number, now: number): DayStats {
  const last = candles[candles.length - 1];
  const today = istDay(last.t);
  const todays = candles.filter((c) => istDay(c.t) === today);
  const earlier = candles.filter((c) => istDay(c.t) < today);
  const byDay = new Map<string, { h: number; l: number }>();
  for (const c of earlier) {
    const d = istDay(c.t);
    const r = byDay.get(d) ?? { h: -Infinity, l: Infinity };
    r.h = Math.max(r.h, c.h);
    r.l = Math.min(r.l, c.l);
    byDay.set(d, r);
  }
  const ranges = [...byDay.values()].map((r) => r.h - r.l).filter((x) => x > 0);
  const prevClose = earlier.length ? earlier[earlier.length - 1].c : null;
  const open = todays[0].o;
  const high = Math.max(...todays.map((c) => c.h));
  const low = Math.min(...todays.map((c) => c.l));
  const avgRangePts = ranges.length ? ranges.reduce((a, b) => a + b, 0) / ranges.length : null;
  const tail = candles.slice(-13);
  let path = 0;
  for (let i = 1; i < tail.length; i++) path += Math.abs(tail[i].c - tail[i - 1].c);
  const efficiency = path > 0 ? Math.abs(tail[tail.length - 1].c - tail[0].c) / path : 0;
  return {
    open,
    high,
    low,
    last: last.c,
    prevClose,
    changePct: prevClose ? ((last.c - prevClose) / prevClose) * 100 : null,
    gapPct: prevClose ? ((open - prevClose) / prevClose) * 100 : null,
    rangePts: high - low,
    avgRangePts,
    rangeUsed: avgRangePts ? (high - low) / avgRangePts : null,
    efficiency,
    rangePos: high > low ? (last.c - low) / (high - low) : 0.5,
    vwapDistPct: vwap ? ((last.c - vwap) / vwap) * 100 : 0,
    atrPct: last.c ? (atr / last.c) * 100 : 0,
    lastCandleAgeMin: Math.max(0, (now - (last.t + 5 * 60_000)) / 60_000),
  };
}

/** Screen one index from its candles + option chain, with the user's own engine settings. */
export function screenIndex(
  symbol: string,
  data: { candles: Candle[]; chain: ChainSnapshot },
  baseCfg: EngineConfig,
  ivHistory: number[],
  now: number,
): ScreenResult {
  const entry = catalogEntry(symbol)!;
  // The user's strategy settings, this index's contract settings; never trades (throwaway state).
  const cfg: EngineConfig = {
    ...baseCfg,
    symbol,
    instrumentKind: entry.kind,
    underlyingSecurityId: entry.underlyingSecurityId,
    underlyingSegment: entry.underlyingSegment,
    tradeSegment: entry.tradeSegment,
    strikeInterval: entry.strikeInterval,
    lotSize: entry.lotSize,
    pointValue: entry.pointValue,
    tickSize: entry.tickSize,
    session: entry.session,
    tradeMode: 'PAPER',
    autoEntryPaper: false,
  };
  const st = { ...initialEngineState(), ivHistory: [...ivHistory] };
  const { dashboard: d } = runCycle(st, cfg, { ...data, now });
  return assess(symbol, entry.label, d, data, cfg, now);
}

function assess(
  symbol: string,
  label: string,
  d: Dashboard,
  data: { candles: Candle[]; chain: ChainSnapshot },
  cfg: EngineConfig,
  now: number,
): ScreenResult {
  const dec = d.decision;
  const direction = dec.direction === 'PE' ? 'PE' : 'CE';
  const bull = direction === 'CE';
  const day = dayStats(data.candles, d.market.vwap, d.market.atr, now);
  const today = istDate(now);
  const expiry = d.expiry || data.chain.expiry;
  const daysToExpiry = expiry ? Math.round((Date.parse(expiry) - Date.parse(today)) / 86400_000) : 99;
  const expiryDay = daysToExpiry === 0;
  const plan = d.candidatePlan;
  const t = ist(now);
  const mins = t.getUTCHours() * 60 + t.getUTCMinutes();
  const marketOpen = sessionOpen(now, 'NSE');
  const cutoff = pastEntryCutoff(cfg, now);

  const pros: string[] = [];
  const warnings: string[] = [];

  // --- score (0–100) ---
  let score = clamp(dec.confidence, 0, 100) * 0.4; // the engine's own confidence
  const eff = day.efficiency;
  score += eff * 25; // clean, directional movement
  if (eff >= 0.5) pros.push(`Clean ${bull ? 'up' : 'down'}-move lately (${Math.round(eff * 100)}% efficient)`);
  const aligned = (bull && dec.trend === 'BULLISH') || (!bull && dec.trend === 'BEARISH');
  if (aligned) {
    score += 15;
    pros.push(`Trend ${dec.trend.toLowerCase()} agrees with ${direction}`);
  } else if (dec.trend === 'SIDEWAYS') {
    score += 5;
    warnings.push('Trend is sideways (EMA20/50 and VWAP disagree)');
  } else {
    warnings.push(`${direction} goes against the ${dec.trend.toLowerCase()} trend`);
  }
  const vwapOk = bull ? day.vwapDistPct > 0 : day.vwapDistPct < 0;
  if (vwapOk) pros.push(`Price ${bull ? 'above' : 'below'} VWAP (${pct(day.vwapDistPct)})`);
  if (day.atrPct >= 0.03 && day.atrPct <= 0.2) score += 10;
  else if (day.atrPct < 0.03) warnings.push('Very quiet: small moves, premiums decay');
  else warnings.push('Very volatile right now: stops get hit fast');
  if (plan && !plan.blocked && plan.qty > 0) score += 10;

  if (eff < 0.25) {
    score -= 10;
    warnings.push(`Choppy: price is going back and forth (${Math.round(eff * 100)}% efficient) — stop-outs likely`);
  }
  if (day.rangeUsed != null && day.rangeUsed > 1.3) {
    score -= 5;
    warnings.push(`Already moved ${day.rangeUsed.toFixed(1)}× a normal day's range — late entries risk a reversal`);
  }
  if (day.gapPct != null && Math.abs(day.gapPct) >= 0.5)
    warnings.push(`Gap ${day.gapPct > 0 ? 'up' : 'down'} ${pct(day.gapPct)} at the open — gaps often partly fill`);
  if (bull && day.rangePos > 0.9) warnings.push('Near the day high — buying calls here chases the move');
  if (!bull && day.rangePos < 0.1) warnings.push('Near the day low — buying puts here chases the move');
  if (expiryDay) {
    score -= 10;
    warnings.push('Expiry day: premiums decay very fast and swing wildly, especially after 13:30');
  } else if (daysToExpiry === 1) warnings.push('Expiry tomorrow: time decay is high');
  if (dec.ivPercentile >= 80) warnings.push(`IV is high (${Math.round(dec.ivPercentile)}th percentile): options are expensive`);
  if (dec.ivPercentile >= 0 && dec.ivPercentile <= 20) pros.push('IV is low: options are cheap to buy');
  if (marketOpen && mins < 9 * 60 + 30) warnings.push('First 15 minutes: opening swings are unreliable');
  if (marketOpen && day.lastCandleAgeMin > 10) warnings.push(`Data looks delayed (last candle ${Math.round(day.lastCandleAgeMin)} min old)`);
  if (plan?.blocked) warnings.push(`ENTER would be refused: ${plan.blocked}`);
  if (dec.confidence < cfg.confWatch) warnings.push(`Confidence ${dec.confidence.toFixed(0)} is below your watch level (${cfg.confWatch})`);
  else if (dec.confidence >= cfg.confHigh) pros.push(`Confidence ${dec.confidence.toFixed(0)} is at or above your trade level (${cfg.confHigh})`);

  score = Math.round(clamp(score, 0, 100));
  let verdict: Verdict;
  if (!marketOpen || cutoff) verdict = 'NO NEW TRADES';
  else if (plan?.blocked || dec.confidence < cfg.confWatch || score < 45) verdict = 'AVOID';
  else if (score >= 65 && aligned && eff >= 0.25 && !expiryDay) verdict = 'GOOD';
  else verdict = 'CAUTION';
  if (!marketOpen) warnings.unshift('Market is closed — this is the last session’s picture');
  else if (cutoff) warnings.unshift(`Past your entry cutoff (${entryCutoff(cfg)} IST): no new trades today`);

  const move =
    day.changePct == null ? '' : `${day.changePct >= 0 ? 'up' : 'down'} ${Math.abs(day.changePct).toFixed(2)}% on the day`;
  const shape = eff >= 0.5 ? 'moving cleanly' : eff < 0.25 ? 'choppy' : 'mixed moves';
  const trendWords = dec.trend === 'SIDEWAYS' ? 'no clear trend' : `${dec.trend.toLowerCase()} trend`;
  const summary = [
    `${label} ${move}`.trim(),
    `${shape}, ${trendWords}`,
    `${day.vwapDistPct >= 0 ? 'above' : 'below'} VWAP`,
    `PCR ${d.chain.pcr.toFixed(2)} (${d.chain.pcr > 1.1 ? 'put writers strong' : d.chain.pcr < 0.9 ? 'call writers strong' : 'balanced'})`,
    `IV ${d.greeks.iv.toFixed(1)}`,
    expiryDay ? 'expiry today' : daysToExpiry <= 7 ? `expiry in ${daysToExpiry} day${daysToExpiry === 1 ? '' : 's'}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    symbol,
    label,
    verdict,
    score,
    direction,
    confidence: dec.confidence,
    signal: dec.signal,
    decision: dec.decisionText,
    trend: dec.trend,
    pattern: dec.pattern,
    pcr: d.chain.pcr,
    iv: d.greeks.iv,
    ivPercentile: dec.ivPercentile,
    expiry,
    expiryDay,
    daysToExpiry,
    spot: d.market.spot,
    day,
    plan,
    pros,
    warnings,
    summary,
  };
}

/** Best first: tradeable verdicts, then score. */
export function rankResults(rs: ScreenResult[]): ScreenResult[] {
  const order: Record<Verdict, number> = { GOOD: 0, CAUTION: 1, AVOID: 2, 'NO NEW TRADES': 3 };
  return [...rs].sort((a, b) => order[a.verdict] - order[b.verdict] || b.score - a.score);
}

export interface ScreenReport {
  at: number;
  results: ScreenResult[];
  /** Indexes that could not be loaded, with the reason. */
  failed: { symbol: string; error: string }[];
  /** Your own day so far (from the engine). */
  account: { tradesToday: number; maxTrades: number; realizedToday: number; lossLockout: boolean; maxDailyLoss: number };
  /** Market-wide notes for today. */
  notes: string[];
}

export function marketNotes(results: ScreenResult[], now: number, account: ScreenReport['account'], cfg: EngineConfig): string[] {
  const notes: string[] = [];
  const t = ist(now);
  const mins = t.getUTCHours() * 60 + t.getUTCMinutes();
  if (!sessionOpen(now, 'NSE')) notes.push('NSE is closed now; figures are from the last session.');
  else if (mins < 9 * 60 + 30) notes.push('Opening phase (before 09:30): wait for the first 15 minutes to settle.');
  else if (mins >= 14 * 60 + 30) notes.push('Late session: moves can reverse into the close; intraday positions square off around 15:20.');
  const cut = entryCutoff(cfg);
  if (cut && !pastEntryCutoff(cfg, now) && sessionOpen(now, 'NSE')) notes.push(`New trades allowed until ${cut} IST.`);
  const dirs = new Set(results.filter((r) => r.verdict !== 'NO NEW TRADES').map((r) => r.direction));
  if (results.length > 1 && dirs.size === 1)
    notes.push(`All indexes point the same way (${[...dirs][0]}): a broad ${[...dirs][0] === 'CE' ? 'up' : 'down'} move.`);
  else if (dirs.size > 1) notes.push('Indexes disagree on direction: a mixed, rotation-type market — be selective.');
  if (results.some((r) => r.expiryDay)) notes.push(`Expiry today for ${results.filter((r) => r.expiryDay).map((r) => r.label).join(', ')}.`);
  if (account.lossLockout) notes.push('You already have a loss today: the no-revenge rule blocks new trades.');
  else if (account.tradesToday >= account.maxTrades) notes.push(`Daily trade limit reached (${account.tradesToday}/${account.maxTrades}).`);
  else notes.push(`Your day: ${account.tradesToday}/${account.maxTrades} trades, booked ${formatINR(account.realizedToday, 0)}.`);
  notes.push('No news or events data here: check the economic calendar (RBI / Fed / results / budget) before trading.');
  return notes;
}

/** Load and screen every index (one after another: Dhan allows one option chain per 3 s). */
export async function screenAll(o: {
  load: (cfg: EngineConfig) => Promise<{ candles: Candle[]; chain: ChainSnapshot }>;
  now: () => number;
  /** The user's engine settings and state (for sizing, filters, IV history, today's counters). */
  config: EngineConfig;
  state: {
    ivHistory: number[];
    ivBank?: Record<string, number[]>;
    tradesToday: number;
    realizedToday: number;
    day: string;
    journal: { date: string; pnl: number | null }[];
  };
}): Promise<ScreenReport> {
  const results: ScreenResult[] = [];
  const failed: { symbol: string; error: string }[] = [];
  for (const symbol of SCREEN_INDEXES) {
    const e = catalogEntry(symbol)!;
    const cfg: EngineConfig = {
      ...o.config,
      symbol,
      instrumentKind: e.kind,
      underlyingSecurityId: e.underlyingSecurityId,
      underlyingSegment: e.underlyingSegment,
      tradeSegment: e.tradeSegment,
      strikeInterval: e.strikeInterval,
      lotSize: e.lotSize,
      pointValue: e.pointValue,
      tickSize: e.tickSize,
      session: e.session,
      expiry: symbol === o.config.symbol ? o.config.expiry : '',
    };
    try {
      const data = await o.load(cfg);
      const iv = symbol === o.config.symbol ? o.state.ivHistory : (o.state.ivBank?.[symbol] ?? []);
      results.push(screenIndex(symbol, data, cfg, iv, o.now()));
    } catch (err) {
      failed.push({ symbol, error: (err as Error).message });
    }
  }
  const s = o.state;
  const account = {
    tradesToday: s.tradesToday,
    maxTrades: o.config.maxTradesPerDay,
    realizedToday: s.realizedToday,
    lossLockout: s.journal.some((j) => j.date === s.day && j.pnl != null && j.pnl < 0),
    maxDailyLoss: o.config.maxDailyLoss,
  };
  const ranked = rankResults(results);
  return { at: o.now(), results: ranked, failed, account, notes: marketNotes(ranked, o.now(), account, o.config) };
}
