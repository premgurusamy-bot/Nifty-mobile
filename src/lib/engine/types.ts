/**
 * Option-buying decision engine — a TypeScript port of the
 * "NIFTY_Option_System_v4" Excel/VBA workbook (Dashboard, Analytics,
 * DecisionEngine, PriceAction, SignalState, Position, IVHistory,
 * TradeJournal, Summary, Backtest modules).
 *
 * Pure data + functions: runs identically on the server (live Dhan data)
 * and in the app (demo mode on simulated data).
 */

import type { InstrumentKind, Session } from './catalog.ts';

/** Option side bought (CE/PE) for index options; LONG/SHORT for futures. */
export type Direction = 'CE' | 'PE' | 'LONG' | 'SHORT';
export type OptionSide = 'CE' | 'PE';
/** +1 = profits when price rises (long futures, any bought option), -1 = short. */
export const sideOf = (d: Direction): 1 | -1 => (d === 'SHORT' ? -1 : 1);
export type TradeMode = 'PAPER' | 'LIVE';

/** 5-minute candle. `t` is epoch ms (candle start). */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** Open interest (futures, when Dhan provides it). */
  oi?: number;
}

/** One side of a strike, as Dhan's option chain returns it (IV in percent, e.g. 9.8). */
export interface Leg {
  ltp: number;
  oi: number;
  prevOi: number;
  volume: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  /** Dhan security id of this option (for live quotes between refreshes). */
  securityId?: string;
}

export interface ChainStrike {
  strike: number;
  ce: Leg | null;
  pe: Leg | null;
}

export interface ChainSnapshot {
  /** Underlying last price reported with the chain (Excel: Dashboard C7). */
  spot: number;
  expiry: string;
  /** Sorted ascending by strike. */
  strikes: ChainStrike[];
  /** Where the data came from (absent = Dhan). */
  feed?: 'DHAN' | 'ANGEL';
  /** Why the data isn't from the feed you chose (e.g. Angel One not logged in → Dhan). */
  feedNote?: string;
  /** Fast ticks: how to quote the spot and the option legs when not through Dhan. */
  quoteSpot?: { segment: string; securityId: string };
  legSegment?: string;
}

/** Editable thresholds — 05_DecisionEngine + 09_Settings in the workbook. */
export interface EngineConfig {
  symbol: string;
  /** INDEX_OPTIONS (workbook option-buying) or MCX_FUTURES (long/short mini futures). */
  instrumentKind: InstrumentKind;
  /** Segment orders go to (NSE_FNO / MCX_COMM). */
  tradeSegment: string;
  /** ₹ per 1.00 price move per quantity unit (options 1; MCX per lot). */
  pointValue: number;
  tickSize: number;
  session: Session;
  /** Cap on lots per trade (0 = sized by max risk only). */
  maxLots: number;
  /** MCX: roll to the next month this many days before expiry. */
  rollDays: number;
  /** MCX: current futures contract (resolved from Dhan's instrument list, or entered by hand). */
  futSecurityId: string;
  futExpiry: string;
  futTradingSymbol: string;
  underlyingSecurityId: number;
  underlyingSegment: string;
  strikeInterval: number;
  /** Blank = nearest expiry from Dhan. */
  expiry: string;
  confHigh: number;
  confWatch: number;
  /** Minutes the score must stay at or above the trade level before entering (0 = enter at once). */
  confirmHoldMinutes: number;
  /** After the hold, only enter if the score is at or above where the hold started (not fading). */
  confirmRising: boolean;
  /** Settings migrations already applied to this saved config. */
  configRev?: number;
  rrTarget: number;
  maxRisk: number;
  lotSize: number;
  atrMult: number;
  maxTradesPerDay: number;
  /** 0 = no limit. */
  maxDailyLoss: number;
  autoRefresh: boolean;
  /** PAPER: the engine trades its signals on paper (like the workbook). LIVE: real Dhan orders, entries only via ENTER. */
  tradeMode: TradeMode;
  /**
   * Multi-index: watch several index-option instruments at once (each with its own setup, hold,
   * IV history and open trade). Several indexes may be in a trade at the same time; when they
   * qualify in the same cycle the higher score enters first (trade 1). Limits and the day plan are shared.
   */
  multiIndex: boolean;
  watchSymbols: string[];
  /** Multi-index size while several index trades are open: SPLIT = each gets 1/N of the normal lots; FULL = each full size. */
  multiSize: 'SPLIT' | 'FULL';
  /** LIVE market entries: seconds to wait for the fill; not filled by then → the order is cancelled. */
  entryFillSeconds: number;
  /** Runtime only (never saved): blocks new entries with this reason (multi-index: another index is in a trade). */
  watchOnly?: string;
  /** PAPER: the engine takes confirmed signals by itself (true) or waits for ENTER (false). */
  autoEntryPaper: boolean;
  /** LIVE: place real entry orders automatically on confirmed signals. Off by default, and
   *  switched off again every time the app is switched to LIVE. */
  autoEntryLive: boolean;
  /** Product for live option orders: INTRADAY (auto square-off) or MARGIN (carry forward / NRML). */
  liveProduct: 'INTRADAY' | 'MARGIN';
  /** Options: skip trades whose premium is below this (₹; 0 = off). */
  minPremium: number;
  /** Options: skip trades whose stop-loss is more than this % of the premium (0 = off). */
  maxStopPct: number;
  /** No new entries after this IST time on NSE instruments ("HH:MM", blank = no cutoff). */
  lastEntryTime: string;
  /** Same for MCX futures (they trade until late evening). */
  lastEntryTimeMcx: string;
  /** Seconds between automatic refreshes (min 3: Dhan allows one option-chain request per 3 s). */
  refreshSeconds: number;
  /** Index options whose market data comes from Angel One instead of Dhan (PAPER only for now). */
  angelSymbols: string[];
  /** Between refreshes, update spot and premiums from Dhan quotes every second (stops / breaks act on them). */
  fastTicks: boolean;
  alertsEnabled: boolean;
  /** RISK: lots sized so the stop costs ≤ max risk. CAPITAL: lots = (capital × %) ÷ cost per lot. */
  sizingMode: SizingMode;
  /** Paper-trading capital (₹). */
  capitalPaper: number;
  /** Live capital (₹); 0 = use the Dhan account's available balance. */
  capitalLive: number;
  /** Share of the capital one trade may use (1–100 %). */
  capitalPct: number;
  /** MCX futures: margin blocked per lot (₹); 0 = estimate at 12 % of the contract value. */
  marginPerLot: number;
  /** FIXED sizing: lots per trade. */
  fixedLots: number;
  /** FIXED sizing, options: stop-loss as % of the entry premium (1–40). MCX keeps its ATR stop. */
  fixedStopPct: number;
  /** ₹ profit lock (trailing on total trade profit); turns Target 2 off. */
  profitLock: boolean;
  /** Lock engages at this profit (₹) … */
  lockStart: number;
  /** … and rises by this much for every further step, one step behind the peak. */
  lockStep: number;
  /** Step locking stops at this secured profit; above it the trade trails (0 = keep stepping). */
  lockRideFrom: number;
  /** Profit the trade may give back from its peak above the ride level (₹). */
  lockRideAmount: number;
  /**
   * Day plan lock (turns Target 2 off, like the profit lock):
   *  trade 1 — best profit dl1At → secure dl1Lock, dl2At → dl2Lock, dl3At → dl3Lock, then the profit
   *            lock ladder keeps trailing above dl3At (never below dl3Lock);
   *  trade 2 — when trade 1 booked at least dayFloor: the stop keeps the day's total ≥ dayFloor,
   *            and the profit lock ladder applies on top;
   *  other trades — the profit lock ladder.
   */
  dayPlanLock: boolean;
  dl1At: number;
  dl1Lock: number;
  dl2At: number;
  dl2Lock: number;
  dl3At: number;
  dl3Lock: number;
  dayFloor: number;
  /**
   * Loss trail (before the profit lock engages): best profit lt1At → the trade may lose lt1Loss at
   * most, lt2At → lt2Loss at most. A step only moves the stop when it is tighter than the stop already
   * there; the stop never moves back.
   */
  lossTrail: boolean;
  lt1At: number;
  lt1Loss: number;
  lt2At: number;
  lt2Loss: number;
}

export type SizingMode = 'RISK' | 'CAPITAL' | 'FIXED';
/** Largest stop-loss you can choose in Fixed-lots mode (% of the option premium). */
export const MAX_FIXED_STOP_PCT = 40;
/** Estimated MCX margin when no per-lot margin is entered (share of price × point value). */
export const EST_MARGIN_PCT = 0.12;

/** Fastest auto-refresh: Dhan's option-chain API takes one request every 3 seconds. */
export const MIN_REFRESH_SECONDS = 3;
/** IV snapshots for the percentile are kept at most this often, whatever the refresh rate. */
export const IV_SNAPSHOT_MS = 15_000;

export const DEFAULT_CONFIG: EngineConfig = {
  symbol: 'NIFTY',
  instrumentKind: 'INDEX_OPTIONS',
  tradeSegment: 'NSE_FNO',
  pointValue: 1,
  tickSize: 0.05,
  session: 'NSE',
  // Guards against absurd sizing when a premium is near zero (expiry afternoon): risk/lot → tiny → lots → huge.
  maxLots: 10,
  rollDays: 3,
  futSecurityId: '',
  futExpiry: '',
  futTradingSymbol: '',
  underlyingSecurityId: 13,
  underlyingSegment: 'IDX_I',
  strikeInterval: 50,
  expiry: '',
  confHigh: 80,
  confirmHoldMinutes: 3,
  confirmRising: true,
  confWatch: 65,
  rrTarget: 2,
  maxRisk: 2000,
  lotSize: 65,
  atrMult: 1.5,
  maxTradesPerDay: 3,
  maxDailyLoss: 3000,
  autoRefresh: false,
  tradeMode: 'PAPER',
  multiIndex: false,
  watchSymbols: ['NIFTY', 'BANKNIFTY'],
  multiSize: 'SPLIT',
  entryFillSeconds: 5,
  autoEntryPaper: true,
  autoEntryLive: false,
  liveProduct: 'INTRADAY',
  minPremium: 40,
  maxStopPct: 25,
  lastEntryTime: '14:35',
  lastEntryTimeMcx: '',
  refreshSeconds: 15,
  fastTicks: true,
  angelSymbols: [],
  alertsEnabled: true,
  sizingMode: 'RISK',
  capitalPaper: 100000,
  capitalLive: 0,
  capitalPct: 100,
  marginPerLot: 0,
  fixedLots: 1,
  fixedStopPct: 20,
  profitLock: false,
  lockStart: 10000,
  lockStep: 5000,
  lockRideFrom: 20000,
  lockRideAmount: 10000,
  dayPlanLock: true,
  dl1At: 9000,
  dl1Lock: 5000,
  dl2At: 12000,
  dl2Lock: 7000,
  dl3At: 14000,
  dl3Lock: 10000,
  dayFloor: 10000,
  lossTrail: true,
  lt1At: 5000,
  lt1Loss: 15000,
  lt2At: 8500,
  lt2Loss: 7000,
};

/** Index presets from Moddhanapi.ApplyIndexPreset (security ids confirmed in the workbook). */
export const INDEX_PRESETS: Record<
  string,
  Pick<EngineConfig, 'symbol' | 'underlyingSecurityId' | 'underlyingSegment' | 'strikeInterval'>
> = {
  NIFTY: { symbol: 'NIFTY', underlyingSecurityId: 13, underlyingSegment: 'IDX_I', strikeInterval: 50 },
  BANKNIFTY: { symbol: 'BANKNIFTY', underlyingSecurityId: 25, underlyingSegment: 'IDX_I', strikeInterval: 100 },
  FINNIFTY: { symbol: 'FINNIFTY', underlyingSecurityId: 27, underlyingSegment: 'IDX_I', strikeInterval: 50 },
};

export interface PendingSetup {
  direction: Direction;
  trigger: number;
  strike: number;
  setAt: number;
  /** Hold-before-entry: when the score last reached the trade level (null = it dipped below since). */
  holdFrom?: number | null;
  /** The score when that hold started (entry needs the score to hold or rise from it). */
  holdConf?: number;
}

/** Dhan order references for a live position. */
export interface LiveLegs {
  securityId: string;
  entryOrderId: string;
  /** Exchange-side stop-loss order protecting the remaining quantity. */
  slOrderId: string | null;
}

export interface OpenPosition {
  direction: Direction;
  strike: number;
  entry: number;
  originalSl: number;
  target1: number;
  target2: number;
  totalQty: number;
  journalId: string;
  openedAt: number;
  partialBooked: boolean;
  partialQty: number;
  partialPnl: number;
  remainingQty: number;
  currentSl: number;
  /** +1 long / -1 short (absent in older saved state = +1). */
  side?: 1 | -1;
  /** ₹ per point per quantity unit (absent = 1). */
  pointValue?: number;
  /** Instrument traded (absent in older saved state = NIFTY). */
  symbol?: string;
  /** Present when the position was opened with real Dhan orders. */
  live?: LiveLegs;
  /** Profit lock: best total profit (₹) seen, and the profit currently secured. */
  peakPnl?: number;
  lockedPnl?: number;
  /** Loss trail: the most this trade may now lose (₹), and the stop price that set it. */
  lossCap?: number;
  lossCapPrice?: number;
  /** Day plan: which rule this trade follows (set when it opens). */
  dayPlan?: 'FIRST' | 'SECOND' | 'NORMAL';
  /** Day plan, trade 2: profit already booked today when it opened. */
  dayBooked?: number;
  /** Stop price the profit lock set (to label a stop-out as a profit-lock exit). */
  lockPrice?: number;
}

export interface JournalRow {
  id: string;
  /** Instrument (absent in rows from before multi-instrument support = NIFTY). */
  symbol?: string;
  /** IST date YYYY-MM-DD */
  date: string;
  /** IST time HH:MM:SS */
  time: string;
  spot: number;
  strike: number;
  direction: Direction;
  entry: number;
  sl: number;
  target: number;
  exit: number | null;
  pnl: number | null;
  confidence: number;
  trend: string;
  pcr: number;
  oiBias: string;
  iv: number;
  delta: number;
  entryReason: string;
  exitReason: string;
  /** Quantity traded (units for options, lots for MCX); absent in older rows. */
  qty?: number;
  /** PAPER or LIVE; absent in older rows (then read from the entry reason). */
  mode?: TradeMode;
  /** IST exit time HH:MM:SS; absent in older rows. */
  exitTime?: string;
  /** ₹ per point per unit (MCX); absent = 1. */
  pointValue?: number;
}

export interface EngineEvent {
  at: number;
  kind: 'SIGNAL' | 'TRADE' | 'PARTIAL' | 'EXIT' | 'INFO' | 'ERROR';
  message: string;
}

/** Persistent state — the auto-managed rows of 05_DecisionEngine plus 07/12 sheets. */
export interface EngineState {
  /** IST date the daily counters belong to. */
  day: string;
  tradesToday: number;
  blockedReason: string;
  pending: PendingSetup | null;
  lastFiredKey: string;
  /** When the last IV snapshot was taken (ms). */
  ivLastAt?: number;
  /** Last confirmed live signal alerted (so each one alerts once). */
  lastSignalKey?: string;
  /** Set for one cycle when LIVE automatic entry should place an order for a new confirmed signal. */
  liveAutoRequest?: string | null;
  realizedToday: number;
  position: OpenPosition | null;
  journal: JournalRow[];
  /** Avg ATM IV snapshots (12_IVHistory column F), oldest first — for the selected instrument. */
  ivHistory: number[];
  /** IV histories of the other instruments, kept while they're not selected. */
  ivBank?: Record<string, number[]>;
  events: EngineEvent[];
  seq: number;
  /** Decision text from the previous cycle (journal entry reason). */
  lastDecisionText: string;
  /** A manual limit entry waiting for the premium to reach its price. */
  pendingEntry: PendingEntry | null;
  /** Multi-index: each watched index's own setup / hold / IV state (see SYMBOL_STATE_KEYS). */
  watch?: Record<string, SymbolState>;
  /** Decision log for export: a row whenever the decision changes, each new candle, and every error. */
  cycleLog?: CycleLogRow[];
}

/** One engine refresh, as exported in the logs (for reviewing / improving the strategy). */
export interface CycleLogRow {
  at: number;
  symbol: string;
  mode: TradeMode;
  /** 'OK' or 'ERROR'. */
  result: 'OK' | 'ERROR';
  spot: number | null;
  trend: string;
  signal: string;
  direction: string;
  strike: number;
  confidence: number | null;
  /** CE / LONG score and PE / SHORT score. */
  scoreUp: number | null;
  scoreDown: number | null;
  pattern: string;
  pcr: number | null;
  ivPercentile: number | null;
  /** "key=points" per factor of the leading direction. */
  factors: string;
  decision: string;
  /** Open position: "PE 24200 @ 82.65 ltp 90.10", or blank. */
  position: string;
  realizedToday: number;
  status: string;
}

/** Manual ENTER at a limit price below the market. */
export interface PendingEntry {
  plan: TradePlan;
  /** Limit price per unit. */
  limit: number;
  placedAt: number;
  /** Set when the limit order was placed with Dhan (LIVE mode). */
  live?: { securityId: string; orderId: string };
}

/** The parts of the engine state that belong to one index (the rest is the shared account). */
export const SYMBOL_STATE_KEYS = [
  'pending',
  'ivHistory',
  'ivLastAt',
  'lastSignalKey',
  'lastDecisionText',
  'blockedReason',
  'liveAutoRequest',
  'lastFiredKey',
  'position',
  'pendingEntry',
] as const;
export type SymbolState = Pick<EngineState, (typeof SYMBOL_STATE_KEYS)[number]>;

export const initialEngineState = (): EngineState => ({
  day: '',
  tradesToday: 0,
  blockedReason: '',
  pending: null,
  lastFiredKey: '',
  realizedToday: 0,
  position: null,
  journal: [],
  ivHistory: [],
  events: [],
  seq: 0,
  lastDecisionText: '',
  pendingEntry: null,
});

export type Signal = 'BUY CE' | 'BUY PE' | 'BUY' | 'SELL' | 'WAIT' | 'NO TRADE' | 'IN POSITION';

/** One scored factor, for display (both option and futures models). */
export interface Factor {
  key: string;
  label: string;
  value: number;
  max: number;
}

export interface TradePlan {
  strike: number;
  direction: Direction;
  entry: number;
  sl: number;
  target1: number;
  target2: number;
  riskPts: number;
  rewardPts: number;
  rr: string;
  qty: number;
  maxLoss: number;
  potentialProfit: number;
  /** How the lots were sized (e.g. "Capital ₹1,00,000 × 100% → 3 lots × ₹21,450"). */
  sizing?: string;
  /** Set when the plan can't be traded (qty 0) — e.g. capital below the cost of 1 lot. */
  blocked?: string;
}

export interface ScoreBreakdown {
  emaTrend: number;
  vwapPosition: number;
  priceAction: number;
  oiBias: number;
  pcr: number;
  deltaFit: number;
  ivLevel: number;
  gamma: number;
  thetaDrag: number;
  volume: number;
}

export const FACTOR_LABELS: Record<keyof ScoreBreakdown, [string, number]> = {
  emaTrend: ['EMA Trend', 15],
  vwapPosition: ['VWAP Position', 10],
  priceAction: ['Market Structure/Price Action', 10],
  oiBias: ['Option OI Bias', 15],
  pcr: ['PCR', 10],
  deltaFit: ['Delta Fit', 10],
  ivLevel: ['IV Level', 10],
  gamma: ['Gamma', 10],
  thetaDrag: ['Theta Drag', 10],
  volume: ['Volume Confirmation', 5],
};

/** Everything the dashboard shows after one refresh (01_Dashboard + 04_Analytics). */
export interface Dashboard {
  at: number;
  status: string;
  expiry: string;
  market: {
    spot: number;
    atm: number;
    trend: string;
    vwap: number;
    ema20: number;
    ema50: number;
    atr: number;
  };
  chain: {
    ceLtp: number;
    peLtp: number;
    ceOi: number;
    peOi: number;
    changeInOi: number;
    pcr: number;
    maxPain: number;
    support: number;
    resistance: number;
    swingSupport: number;
    swingResistance: number;
    distanceFromMaxPain: number;
  };
  greeks: { delta: number; gamma: number; theta: number; vega: number; iv: number };
  decision: {
    sentiment: string;
    trend: string;
    oiStrength: string;
    confidence: number;
    decisionText: string;
    signal: Signal;
    direction: Direction;
    selectedStrike: number;
    pattern: string;
    ivPercentile: number;
    scoreCE: number;
    scorePE: number;
  };
  breakdown: ScoreBreakdown;
  /** Score factors in display order (options: the workbook's 10; futures: the futures model). */
  factors: Factor[];
  /** Futures-only market details. */
  futures?: {
    contract: string;
    expiry: string;
    dayOpen: number;
    oi: number;
    oiChange: number;
    buildup: string;
    momentum: number;
  };
  plan: TradePlan | null;
  /** What a manual ENTER would trade now (null while a position is open). */
  candidatePlan: TradePlan | null;
  /** Live premium of the open position's strike, when one is open. */
  positionLtp: number | null;
  /** How the scoring thresholds were scaled for this instrument (NIFTY: none). */
  calibration?: { base: boolean; price: number; vol: number; lot: number };
}
