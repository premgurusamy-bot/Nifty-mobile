/**
 * Port of modBacktest (technical + price-action half only — Dhan has no
 * historical option chain, so OI/PCR/Greeks can't be replayed) and modSummary.
 * Trades are simulated in underlying index points, not option premium.
 */
import { computeTechnical } from './indicators.ts';
import { scoreCandle, swingLevels } from './priceAction.ts';
import type { Candle, Direction, EngineConfig, JournalRow } from './types.ts';

const SIM_CONF_THRESHOLD = 20; // out of a 35-point technical-only scale
const MAX_BARS_TO_CONFIRM = 6;
const MAX_BARS_TO_HOLD = 24;
/** First candle index evaluated (sheet row 53 → EMA50 warm-up). */
const START_INDEX = 51;

export interface BacktestTrade {
  entryTime: number;
  direction: Direction;
  entry: number;
  sl: number;
  target: number;
  exitTime: number;
  exit: number;
  result: 'WIN (TARGET)' | 'LOSS (SL)' | 'TIMED OUT (mkt exit)';
  points: number;
  pattern: string;
}

export interface BacktestResult {
  armed: number;
  confirmed: number;
  wins: number;
  losses: number;
  timedOut: number;
  winRate: number;
  totalPoints: number;
  avgPoints: number;
  trades: BacktestTrade[];
  candles: number;
}

export function runBacktest(c: Candle[], cfg: Pick<EngineConfig, 'atrMult' | 'rrTarget'>): BacktestResult {
  const res: BacktestResult = {
    armed: 0,
    confirmed: 0,
    wins: 0,
    losses: 0,
    timedOut: 0,
    winRate: 0,
    totalPoints: 0,
    avgPoints: 0,
    trades: [],
    candles: c.length,
  };
  if (c.length < 59) return res; // workbook requires 60+ sheet rows
  const tech = computeTechnical(c)!;
  const last = c.length - 1;
  let pendingDir: Direction | null = null;
  let trigger = 0;
  let armedAt = 0;

  for (let r = START_INDEX; r <= last; r++) {
    const close = c[r].c;
    const e20 = tech.ema20[r];
    const e50 = tech.ema50[r];
    const vw = tech.vwap[r];
    const trend =
      e20 > e50 && close > e20 && close > vw
        ? 'BULLISH'
        : e20 < e50 && close < e20 && close < vw
          ? 'BEARISH'
          : 'SIDEWAYS';
    const sw = swingLevels(c, r);
    const pa = scoreCandle(c, tech, r, { swingSupport: sw.support, swingResistance: sw.resistance }, false);
    const scoreCE = (trend === 'BULLISH' ? 25 : trend === 'SIDEWAYS' ? 10 : 0) + pa.bull;
    const scorePE = (trend === 'BEARISH' ? 25 : trend === 'SIDEWAYS' ? 10 : 0) + pa.bear;
    const candDir: Direction = scoreCE >= scorePE ? 'CE' : 'PE';
    const candScore = Math.max(scoreCE, scorePE);

    if (!pendingDir) {
      if (candScore >= SIM_CONF_THRESHOLD) {
        pendingDir = candDir;
        trigger = candDir === 'CE' ? c[r].h : c[r].l;
        armedAt = r;
        res.armed++;
      }
      continue;
    }
    if (r - armedAt > MAX_BARS_TO_CONFIRM) {
      pendingDir = null;
      continue;
    }
    const confirmed = pendingDir === 'CE' ? c[r].h > trigger : c[r].l < trigger;
    if (!confirmed) continue;

    res.confirmed++;
    const entry = trigger;
    let risk = tech.atr[r] * cfg.atrMult;
    if (risk <= 0) risk = entry * 0.003;
    const sl = pendingDir === 'CE' ? entry - risk : entry + risk;
    const target = pendingDir === 'CE' ? entry + risk * cfg.rrTarget : entry - risk * cfg.rrTarget;

    let exitIdx = -1;
    let exit = 0;
    let result: BacktestTrade['result'] = 'TIMED OUT (mkt exit)';
    const until = Math.min(last, r + MAX_BARS_TO_HOLD);
    for (let f = r + 1; f <= until; f++) {
      if (pendingDir === 'CE') {
        if (c[f].l <= sl) {
          exitIdx = f;
          exit = sl;
          result = 'LOSS (SL)';
          break;
        } else if (c[f].h >= target) {
          exitIdx = f;
          exit = target;
          result = 'WIN (TARGET)';
          break;
        }
      } else if (c[f].h >= sl) {
        exitIdx = f;
        exit = sl;
        result = 'LOSS (SL)';
        break;
      } else if (c[f].l <= target) {
        exitIdx = f;
        exit = target;
        result = 'WIN (TARGET)';
        break;
      }
    }
    if (exitIdx < 0) {
      exitIdx = until;
      exit = c[until].c;
      res.timedOut++;
    }
    const points = pendingDir === 'CE' ? exit - entry : entry - exit;
    res.totalPoints += points;
    if (result === 'WIN (TARGET)') res.wins++;
    if (result === 'LOSS (SL)') res.losses++;
    res.trades.push({
      entryTime: c[r].t,
      direction: pendingDir,
      entry,
      sl,
      target,
      exitTime: c[exitIdx].t,
      exit,
      result,
      points,
      pattern: pa.label,
    });
    pendingDir = null;
  }
  res.winRate = res.wins + res.losses > 0 ? res.wins / (res.wins + res.losses) : 0;
  res.avgPoints = res.confirmed > 0 ? res.totalPoints / res.confirmed : 0;
  return res;
}

export interface SummaryDay {
  date: string;
  trades: number;
  wins: number;
  losses: number;
  pnl: number;
  cumulative: number;
}

/** modSummary.RefreshSummary: closed trades grouped by day with cumulative P&L. */
export function summarizeJournal(journal: JournalRow[]): SummaryDay[] {
  const days: SummaryDay[] = [];
  for (const j of journal) {
    if (j.pnl == null) continue;
    let d = days.find((x) => x.date === j.date);
    if (!d) {
      d = { date: j.date, trades: 0, wins: 0, losses: 0, pnl: 0, cumulative: 0 };
      days.push(d);
    }
    d.pnl += j.pnl;
    d.trades++;
    if (j.pnl > 0) d.wins++;
    if (j.pnl < 0) d.losses++;
  }
  let cum = 0;
  for (const d of days) {
    cum += d.pnl;
    d.cumulative = cum;
  }
  return days;
}
