/**
 * Port of modDecisionEngine + modSignalState + modPosition + modIVHistory +
 * modTradeJournal — one refresh cycle of the workbook's RefreshAll, minus the
 * data fetching (the caller supplies candles and the option chain).
 *
 * Deliberate differences from the VBA (bug fixes, documented in README):
 *  - SelectBestStrike steps by the configured strike interval (VBA used the
 *    hard-coded 50 even for BANKNIFTY).
 *  - The no-revenge-trade check compares journal dates reliably (VBA compared
 *    a Date cell to a "yyyy-mm-dd" string).
 *  - R:R is reported as text "1:2" (Excel auto-converted it to a time).
 */
import { computeChainMetrics, computeTechnical, findStrike, legOf } from './indicators.ts';
import { livePriceAction } from './priceAction.ts';
import type {
  Candle,
  ChainSnapshot,
  Dashboard,
  Direction,
  EngineConfig,
  EngineEvent,
  EngineState,
  JournalRow,
  Leg,
  LiveLegs,
  OpenPosition,
  ScoreBreakdown,
  Signal,
  TradePlan,
} from './types.ts';

const IV_HISTORY_MAX = 20000;
const EVENTS_MAX = 100;

const pad = (n: number) => String(n).padStart(2, '0');
const ist = (ms: number) => new Date(ms + 5.5 * 3600_000);
export const istDate = (ms: number) => ist(ms).toISOString().slice(0, 10);
export const istTime = (ms: number) => {
  const d = ist(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};
const fmt2 = (n: number) => n.toFixed(2);

/** Mon-Fri 09:15-15:30 IST (IsWithinMarketHours; holidays not modelled). */
export function isWithinMarketHours(ms: number): boolean {
  const d = ist(ms);
  const wd = d.getUTCDay();
  if (wd === 0 || wd === 6) return false;
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

// ---------------------------------------------------------------- state helpers

function pushEvent(s: EngineState, ev: Omit<EngineEvent, 'at'>, now: number) {
  s.events = [{ ...ev, at: now }, ...s.events].slice(0, EVENTS_MAX);
}

/** ResetIfNewDay */
export function resetIfNewDay(s: EngineState, now: number) {
  const today = istDate(now);
  if (s.day !== today) {
    s.day = today;
    s.tradesToday = 0;
    s.blockedReason = '';
    s.realizedToday = 0;
    s.pending = null;
    // Paper limit entries are day orders. A live one stays tracked until Dhan itself
    // reports it expired/cancelled, so it can never become an untracked orphan.
    if (s.pendingEntry && !s.pendingEntry.live) s.pendingEntry = null;
  }
}

function todayHasLoggedLoss(s: EngineState): boolean {
  return s.journal.some((j) => j.date === s.day && j.pnl != null && j.pnl < 0);
}

/** CanTakeNewTrade: max trades/day, no-revenge-trade, rupee daily max loss. */
export function canTakeNewTrade(s: EngineState, cfg: EngineConfig): { ok: boolean; reason: string } {
  if (s.tradesToday >= cfg.maxTradesPerDay) {
    return { ok: false, reason: `Daily trade limit reached (${s.tradesToday}/${cfg.maxTradesPerDay})` };
  }
  if (todayHasLoggedLoss(s)) return { ok: false, reason: 'No-revenge-trade rule: a loss was logged today' };
  if (cfg.maxDailyLoss > 0 && s.realizedToday <= -cfg.maxDailyLoss) {
    return {
      ok: false,
      reason: `Daily max loss reached (Rs ${Math.round(s.realizedToday)} / limit -Rs ${Math.round(cfg.maxDailyLoss)})`,
    };
  }
  return { ok: true, reason: '' };
}

// ---------------------------------------------------------------- IV history

export function captureIVSnapshot(s: EngineState, chain: ChainSnapshot, atm: number) {
  const row = findStrike(chain, atm);
  if (!row) return;
  const ce = row.ce?.iv ?? 0;
  const pe = row.pe?.iv ?? 0;
  if (ce <= 0 && pe <= 0) return;
  const avg = ce > 0 && pe > 0 ? (ce + pe) / 2 : ce > 0 ? ce : pe;
  s.ivHistory.push(avg);
  if (s.ivHistory.length > IV_HISTORY_MAX) s.ivHistory = s.ivHistory.slice(s.ivHistory.length - IV_HISTORY_MAX);
}

/** Percentile rank 0-100, or -1 when fewer than 20 snapshots exist. */
export function ivPercentile(history: number[], iv: number): number {
  if (iv <= 0 || history.length < 20) return -1;
  let le = 0;
  for (const h of history) if (h > 0 && h <= iv) le++;
  return (le / history.length) * 100;
}

function scoreIV(history: number[], iv: number): number {
  if (iv <= 0) return 0;
  const pct = ivPercentile(history, iv);
  if (pct >= 0) return pct <= 20 ? 10 : pct <= 50 ? 6 : pct <= 80 ? 3 : 0;
  return iv <= 20 ? 10 : iv <= 30 ? 5 : 0;
}

// ---------------------------------------------------------------- scoring

/** SelectBestStrike: ATM and the next 2 OTM strikes, best delta-fit / IV / liquidity. */
export function selectBestStrike(chain: ChainSnapshot, dir: Direction, atm: number, interval: number): number {
  if (!chain.strikes.length) return atm;
  const sign = dir === 'CE' ? 1 : -1;
  let best = atm;
  let bestScore = -1;
  for (let k = 0; k <= 2; k++) {
    const cand = atm + sign * k * interval;
    const leg = legOf(findStrike(chain, cand), dir);
    if (!leg) continue;
    const delta = Math.abs(leg.delta);
    let score = 0;
    if (delta >= 0.35 && delta <= 0.6) score += 10;
    else if (delta > 0) score += 4;
    if (leg.iv > 0 && leg.iv <= 20) score += 5;
    else if (leg.iv > 0 && leg.iv <= 30) score += 2;
    if (leg.oi > 0) score += Math.min(3, leg.oi / 100000);
    if (leg.volume > 0) score += Math.min(2, leg.volume / 50000);
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  return best;
}

export interface ScoreInputs {
  pcr: number;
  priceAction: number;
  ema20: number;
  ema50: number;
  vwap: number;
  spot: number;
  leg: Leg | null;
  ivHistory: number[];
}

/** ScoreDirection: 10 factors, total 0-105. */
export function scoreDirection(dir: Direction, x: ScoreInputs): { total: number; breakdown: ScoreBreakdown } {
  const bull = dir === 'CE';
  const emaState =
    x.ema20 > x.ema50 && x.spot > x.ema20 ? 'BULLISH' : x.ema20 < x.ema50 && x.spot < x.ema20 ? 'BEARISH' : 'SIDEWAYS';
  const emaTrend =
    (bull && emaState === 'BULLISH') || (!bull && emaState === 'BEARISH') ? 15 : emaState === 'SIDEWAYS' ? 6 : 0;

  const pct = x.vwap !== 0 ? ((x.spot - x.vwap) / x.vwap) * 100 : 0;
  const vwapPosition = bull ? (pct > 0.05 ? 10 : pct > 0 ? 5 : 0) : pct < -0.05 ? 10 : pct < 0 ? 5 : 0;

  const oiBias = bull ? (x.pcr > 1.1 ? 15 : x.pcr > 1 ? 8 : 0) : x.pcr < 0.9 ? 15 : x.pcr < 1 ? 8 : 0;
  const dist = Math.abs(x.pcr - 1);
  const pcr = bull ? (x.pcr >= 1 ? Math.min(10, dist * 20) : 0) : x.pcr <= 1 ? Math.min(10, dist * 20) : 0;

  const leg = x.leg;
  const absDelta = Math.abs(leg?.delta ?? 0);
  const deltaFit = absDelta >= 0.35 && absDelta <= 0.6 ? 10 : absDelta > 0 ? 4 : 0;
  const ivLevel = scoreIV(x.ivHistory, leg?.iv ?? 0);
  const absGamma = Math.abs(leg?.gamma ?? 0);
  const gamma = absGamma >= 0.001 && absGamma <= 0.01 ? 10 : absGamma > 0 ? 4 : 0;
  const absTheta = Math.abs(leg?.theta ?? 0);
  const thetaDrag = absTheta < 5 ? 10 : absTheta < 15 ? 5 : 0;
  const vol = leg?.volume ?? 0;
  const oi = leg?.oi ?? 0;
  let volume = 0;
  if (oi > 0 && vol / oi > 0.05) volume = 5;
  if (volume === 0 && vol > 0) volume = 2;

  const breakdown: ScoreBreakdown = {
    emaTrend,
    vwapPosition,
    priceAction: x.priceAction,
    oiBias,
    pcr,
    deltaFit,
    ivLevel,
    gamma,
    thetaDrag,
    volume,
  };
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { total, breakdown };
}

/** BuildTradePlan: ATR × multiplier × delta risk in premium points, sized to max risk. */
export function buildTradePlan(
  chain: ChainSnapshot,
  dir: Direction,
  strike: number,
  atr: number,
  cfg: EngineConfig,
): TradePlan | null {
  const leg = legOf(findStrike(chain, strike), dir);
  if (!leg) return null;
  const entry = leg.ltp;
  const delta = Math.abs(leg.delta) || 0.4;
  let riskPts = atr * cfg.atrMult * delta;
  if (riskPts <= 0) riskPts = entry * 0.1;
  const sl = Math.max(entry - riskPts, 0.05);
  const target1 = entry + riskPts * cfg.rrTarget;
  const target2 = entry + riskPts * cfg.rrTarget * 1.5;
  const lots = Math.max(1, Math.floor(cfg.maxRisk / (riskPts * cfg.lotSize)));
  const qty = lots * cfg.lotSize;
  return {
    strike,
    direction: dir,
    entry,
    sl,
    target1,
    target2,
    riskPts,
    rewardPts: riskPts * cfg.rrTarget,
    rr: `1:${cfg.rrTarget.toFixed(1)}`,
    qty,
    maxLoss: riskPts * qty,
    potentialProfit: (target1 - entry) * qty,
  };
}

// ---------------------------------------------------------------- position management

function journalRow(s: EngineState, id: string) {
  return s.journal.find((j) => j.id === id);
}

function finalize(
  s: EngineState,
  p: OpenPosition,
  exitPrice: number,
  legQty: number,
  booked: number,
  reason: string,
  now: number,
) {
  const legPnl = (exitPrice - p.entry) * legQty;
  const total = legPnl + booked;
  const j = journalRow(s, p.journalId);
  if (j) {
    j.exit = exitPrice;
    j.pnl = total;
    j.exitReason = `${reason} (auto-closed, total P&L Rs ${Math.round(total)})`;
  }
  s.realizedToday += legPnl;
  s.position = null;
  pushEvent(
    s,
    {
      kind: 'EXIT',
      message: `${p.direction} ${p.strike} closed - ${reason} at ${fmt2(exitPrice)}, P&L Rs ${fmt2(total)}`,
    },
    now,
  );
}

/**
 * CheckAndCloseIfHit: book half at T1 (2+ lots) and trail the rest to breakeven;
 * full exit on SL / T2. Exits are recorded at the SL/target level itself,
 * exactly like the workbook.
 */
export function checkAndCloseIfHit(s: EngineState, ltp: number, cfg: EngineConfig, now: number): boolean {
  const p = s.position;
  if (!p || ltp <= 0) return false;
  if (!p.partialBooked) {
    if (ltp <= p.currentSl) {
      finalize(s, p, p.currentSl, p.totalQty, 0, 'SL HIT (full)', now);
      return true;
    }
    if (ltp >= p.target1) {
      const lotsTotal = cfg.lotSize > 0 ? Math.floor(p.totalQty / cfg.lotSize) : 0;
      if (cfg.lotSize <= 0 || lotsTotal < 2) {
        finalize(s, p, p.target1, p.totalQty, 0, "TARGET 1 HIT (full - only 1 lot, can't split)", now);
        return true;
      }
      const halfQty = Math.floor(lotsTotal / 2) * cfg.lotSize;
      const booked = (p.target1 - p.entry) * halfQty;
      p.partialBooked = true;
      p.partialQty = halfQty;
      p.partialPnl = booked;
      p.remainingQty = p.totalQty - halfQty;
      p.currentSl = p.entry;
      s.realizedToday += booked;
      const j = journalRow(s, p.journalId);
      if (j) {
        j.exitReason = `Partial: booked ${halfQty} @ ${fmt2(p.target1)} (+Rs ${Math.round(booked)}), SL trailed to breakeven ${fmt2(p.entry)}`;
      }
      pushEvent(
        s,
        {
          kind: 'PARTIAL',
          message: `${p.direction} ${p.strike} - booked ${halfQty} @ ${fmt2(p.target1)}, rest trailing to breakeven`,
        },
        now,
      );
      return true;
    }
    return false;
  }
  if (ltp <= p.currentSl) {
    finalize(s, p, p.currentSl, p.remainingQty, p.partialPnl, 'TRAIL SL HIT (remainder)', now);
    return true;
  }
  if (ltp >= p.target2) {
    finalize(s, p, p.target2, p.remainingQty, p.partialPnl, 'TARGET 2 HIT (remainder)', now);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- opening / closing trades

export interface OpenTradeArgs {
  direction: Direction;
  plan: TradePlan;
  /** Actual entry price (plan LTP for paper, average fill for live). */
  entry: number;
  qty: number;
  now: number;
  spot: number;
  confidence: number;
  trend: string;
  pcr: number;
  oiBias: string;
  iv: number;
  delta: number;
  reason: string;
  live?: LiveLegs;
}

/**
 * Journal + open the position + daily counters (LogSignal / OpenPosition / IncrementTradesToday).
 * SL and targets keep the plan's distances from the actual entry price.
 */
export function openTrade(s: EngineState, cfg: EngineConfig, a: OpenTradeArgs): OpenPosition {
  const shift = a.entry - a.plan.entry;
  const sl = Math.max(0.05, a.plan.sl + shift);
  const target1 = a.plan.target1 + shift;
  const target2 = a.plan.target2 + shift;
  const id = `J${++s.seq}`;
  const row: JournalRow = {
    id,
    date: istDate(a.now),
    time: istTime(a.now),
    spot: a.spot,
    strike: a.plan.strike,
    direction: a.direction,
    entry: a.entry,
    sl,
    target: target1,
    exit: null,
    pnl: null,
    confidence: a.confidence,
    trend: a.trend,
    pcr: a.pcr,
    oiBias: a.oiBias,
    iv: a.iv,
    delta: a.delta,
    entryReason: a.reason,
    exitReason: '',
  };
  s.journal.push(row);
  s.position = {
    direction: a.direction,
    strike: a.plan.strike,
    entry: a.entry,
    originalSl: sl,
    target1,
    target2,
    totalQty: a.qty,
    journalId: id,
    openedAt: a.now,
    partialBooked: false,
    partialQty: 0,
    partialPnl: 0,
    remainingQty: a.qty,
    currentSl: sl,
    live: a.live,
  };
  pushEvent(
    s,
    {
      kind: 'TRADE',
      message: `${cfg.symbol} ${a.live ? 'LIVE' : 'signal'}: BUY ${a.direction} ${a.plan.strike} @ ${fmt2(a.entry)}`,
    },
    a.now,
  );
  s.tradesToday += 1;
  s.lastFiredKey = `${istDate(a.now)}|${a.direction}|${a.plan.strike}`;
  s.pending = null;
  return s.position;
}

/** Close whatever quantity is still open at `price` (manual exit, or an exchange stop that filled). */
export function closeOpenPosition(s: EngineState, price: number, reason: string, now: number): boolean {
  const p = s.position;
  if (!p) return false;
  finalize(s, p, price, p.remainingQty, p.partialPnl, reason, now);
  return true;
}

// ---------------------------------------------------------------- the refresh cycle

export interface RefreshInput {
  candles: Candle[];
  chain: ChainSnapshot;
  now: number;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/**
 * One full RefreshAll cycle (after data fetch): ComputeTechnical,
 * ComputeOptionChainMetrics, RunDecisionEngine. Returns a new state.
 */
export function runCycle(
  prev: EngineState,
  cfg: EngineConfig,
  input: RefreshInput,
): { state: EngineState; dashboard: Dashboard } {
  const s = clone(prev);
  const { candles, chain, now } = input;
  resetIfNewDay(s, now);

  const tech = computeTechnical(candles);
  const metrics = computeChainMetrics(chain);
  if (!tech || !metrics) throw new Error(!tech ? 'No candle data' : 'Option chain is empty');

  const spot = chain.spot || tech.last.close;
  const pa = livePriceAction(candles, tech, metrics.support, metrics.resistance);

  captureIVSnapshot(s, chain, metrics.atm);

  const bestCE = selectBestStrike(chain, 'CE', metrics.atm, cfg.strikeInterval);
  const bestPE = selectBestStrike(chain, 'PE', metrics.atm, cfg.strikeInterval);
  const base = {
    pcr: metrics.pcr,
    ema20: tech.last.ema20,
    ema50: tech.last.ema50,
    vwap: tech.last.vwap,
    spot,
    ivHistory: s.ivHistory,
  };
  const ce = scoreDirection('CE', { ...base, priceAction: pa.bull, leg: legOf(findStrike(chain, bestCE), 'CE') });
  const pe = scoreDirection('PE', { ...base, priceAction: pa.bear, leg: legOf(findStrike(chain, bestPE), 'PE') });

  const direction: Direction = ce.total >= pe.total ? 'CE' : 'PE';
  const confidence = direction === 'CE' ? ce.total : pe.total;
  const selectedStrike = direction === 'CE' ? bestCE : bestPE;
  const breakdown = direction === 'CE' ? ce.breakdown : pe.breakdown;

  const sentiment =
    metrics.pcr > 1.1
      ? 'BULLISH (PUT WRITERS DOMINANT)'
      : metrics.pcr < 0.9
        ? 'BEARISH (CALL WRITERS DOMINANT)'
        : 'NEUTRAL';
  const oiStrength =
    metrics.pcr > 1 ? 'PE OI HEAVY (SUPPORT)' : metrics.pcr < 1 ? 'CE OI HEAVY (RESISTANCE)' : 'BALANCED';

  const selRow = findStrike(chain, selectedStrike);
  const selLeg = legOf(selRow, direction);
  const greeks = {
    delta: selLeg?.delta ?? 0,
    gamma: selLeg?.gamma ?? 0,
    theta: selLeg?.theta ?? 0,
    vega: selLeg?.vega ?? 0,
    iv: selLeg?.iv ?? 0,
  };

  // Open position check first (uses this cycle's chain LTP for its strike).
  let positionLtp: number | null = null;
  if (s.position) {
    positionLtp = legOf(findStrike(chain, s.position.strike), s.position.direction)?.ltp ?? 0;
    checkAndCloseIfHit(s, positionLtp, cfg, now);
  }

  let signal: Signal;
  let decisionText: string;
  let plan: TradePlan | null = null;
  const label = pa.label;

  if (s.position) {
    signal = 'IN POSITION';
    decisionText = 'POSITION OPEN - monitoring for SL/Target';
    s.pending = null;
  } else if (confidence < cfg.confWatch) {
    s.pending = null;
    signal = 'NO TRADE';
    decisionText = `NO TRADE (${label})`;
  } else if (confidence < cfg.confHigh) {
    signal = 'WAIT';
    decisionText = `WATCH - CONFIRMATION BUILDING (${label})`;
  } else {
    const gate = canTakeNewTrade(s, cfg);
    if (!gate.ok) {
      s.blockedReason = gate.reason;
      signal = 'NO TRADE';
      decisionText = `BLOCKED - ${gate.reason}`;
    } else {
      const last = candles[candles.length - 1];
      const same = s.pending && s.pending.direction === direction && Math.abs(s.pending.strike - selectedStrike) < 0.01;
      if (!same) {
        const trigger = direction === 'CE' ? last.h : last.l;
        s.pending = { direction, trigger, strike: selectedStrike, setAt: now };
        signal = 'WAIT';
        decisionText = `SETUP ARMED - waiting for break of ${fmt2(trigger)} (${label})`;
      } else {
        const trig = s.pending!.trigger;
        const confirmed = direction === 'CE' ? last.h > trig : last.l < trig;
        const key = `${istDate(now)}|${direction}|${selectedStrike}`;
        if (!confirmed) {
          signal = 'WAIT';
          decisionText = `SETUP PENDING - waiting for break of ${fmt2(trig)} (${label})`;
        } else if (key === s.lastFiredKey) {
          signal = 'NO TRADE';
          decisionText = `ALREADY TAKEN TODAY (${direction} ${selectedStrike})`;
        } else {
          const tp = buildTradePlan(chain, direction, selectedStrike, tech.last.atr, cfg);
          if (!tp) {
            signal = 'WAIT';
            decisionText = `SETUP PENDING - strike ${selectedStrike} missing from chain`;
          } else {
            plan = tp;
            signal = direction === 'CE' ? 'BUY CE' : 'BUY PE';
            decisionText = `TRADE - CONFIRMED BREAK (${label})`;
            if (cfg.tradeMode === 'LIVE') {
              // Live mode never trades by itself: the confirmed signal waits for ENTER.
              decisionText = `SIGNAL CONFIRMED - tap ENTER to trade live (${label})`;
            } else if (s.pendingEntry) {
              // Your own limit entry is waiting — don't stack an automatic one on top.
              decisionText = `SIGNAL CONFIRMED - your limit entry @ ${fmt2(s.pendingEntry.limit)} is pending (${label})`;
            } else {
              openTrade(s, cfg, {
                direction,
                plan: tp,
                entry: tp.entry,
                qty: tp.qty,
                now,
                spot,
                confidence,
                trend: tech.trend,
                pcr: metrics.pcr,
                oiBias: oiStrength,
                iv: greeks.iv,
                delta: greeks.delta,
                // LogSignal runs before the dashboard's decision cell is rewritten, so the
                // workbook journals the previous cycle's setup text — kept as-is.
                reason: `Auto-signal: ${s.lastDecisionText || decisionText} | Confidence ${confidence.toFixed(2)}/100`,
              });
              positionLtp = tp.entry;
            }
          }
        }
      }
    }
  }

  s.lastDecisionText = decisionText;

  // What a manual ENTER would trade right now: the best strike for the leading direction.
  const candidatePlan = s.position
    ? null
    : (plan ?? buildTradePlan(chain, direction, selectedStrike, tech.last.atr, cfg));

  const dashboard: Dashboard = {
    at: now,
    status: 'Ready',
    expiry: chain.expiry,
    market: {
      spot,
      atm: metrics.atm,
      trend: tech.trend,
      vwap: tech.last.vwap,
      ema20: tech.last.ema20,
      ema50: tech.last.ema50,
      atr: tech.last.atr,
    },
    chain: {
      ceLtp: selRow?.ce?.ltp ?? 0,
      peLtp: selRow?.pe?.ltp ?? 0,
      ceOi: selRow?.ce?.oi ?? 0,
      peOi: selRow?.pe?.oi ?? 0,
      changeInOi:
        (selRow?.ce?.oi ?? 0) - (selRow?.ce?.prevOi ?? 0) - ((selRow?.pe?.oi ?? 0) - (selRow?.pe?.prevOi ?? 0)),
      pcr: metrics.pcr,
      maxPain: metrics.maxPain,
      support: metrics.support,
      resistance: metrics.resistance,
      swingSupport: pa.swingSupport,
      swingResistance: pa.swingResistance,
      distanceFromMaxPain: Math.abs(spot - metrics.maxPain),
    },
    greeks,
    decision: {
      sentiment,
      trend: tech.trend,
      oiStrength,
      confidence,
      decisionText,
      signal,
      direction,
      selectedStrike,
      pattern: label,
      ivPercentile: ivPercentile(s.ivHistory, greeks.iv),
      scoreCE: ce.total,
      scorePE: pe.total,
    },
    breakdown,
    plan,
    candidatePlan,
    positionLtp,
  };
  return { state: s, dashboard };
}
