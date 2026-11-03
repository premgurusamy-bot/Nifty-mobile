/**
 * Option-buying decision engine — a TypeScript port of the
 * "NIFTY_Option_System_v4" Excel/VBA workbook (Dashboard, Analytics,
 * DecisionEngine, PriceAction, SignalState, Position, IVHistory,
 * TradeJournal, Summary, Backtest modules).
 *
 * Pure data + functions: runs identically on the server (live Dhan data)
 * and in the app (demo mode on simulated data).
 */

export type Direction = 'CE' | 'PE';
export type TradeMode = 'PAPER' | 'LIVE';

/** 5-minute candle. `t` is epoch ms (candle start). */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
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
}

/** Editable thresholds — 05_DecisionEngine + 09_Settings in the workbook. */
export interface EngineConfig {
  symbol: string;
  underlyingSecurityId: number;
  underlyingSegment: string;
  strikeInterval: number;
  /** Blank = nearest expiry from Dhan. */
  expiry: string;
  confHigh: number;
  confWatch: number;
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
  /** Product for live option orders: INTRADAY (auto square-off) or MARGIN (carry forward / NRML). */
  liveProduct: 'INTRADAY' | 'MARGIN';
  /** Seconds between automatic refreshes (floor 15, like the workbook). */
  refreshSeconds: number;
  alertsEnabled: boolean;
}

export const DEFAULT_CONFIG: EngineConfig = {
  symbol: 'NIFTY',
  underlyingSecurityId: 13,
  underlyingSegment: 'IDX_I',
  strikeInterval: 50,
  expiry: '',
  confHigh: 80,
  confWatch: 65,
  rrTarget: 2,
  maxRisk: 2000,
  lotSize: 65,
  atrMult: 1.5,
  maxTradesPerDay: 3,
  maxDailyLoss: 3000,
  autoRefresh: false,
  tradeMode: 'PAPER',
  liveProduct: 'INTRADAY',
  refreshSeconds: 15,
  alertsEnabled: true,
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
  /** Present when the position was opened with real Dhan orders. */
  live?: LiveLegs;
}

export interface JournalRow {
  id: string;
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
}

export interface EngineEvent {
  at: number;
  kind: 'TRADE' | 'PARTIAL' | 'EXIT' | 'INFO' | 'ERROR';
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
  realizedToday: number;
  position: OpenPosition | null;
  journal: JournalRow[];
  /** Avg ATM IV snapshots (12_IVHistory column F), oldest first. */
  ivHistory: number[];
  events: EngineEvent[];
  seq: number;
  /** Decision text from the previous cycle (journal entry reason). */
  lastDecisionText: string;
  /** A manual limit entry waiting for the premium to reach its price. */
  pendingEntry: PendingEntry | null;
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

export type Signal = 'BUY CE' | 'BUY PE' | 'WAIT' | 'NO TRADE' | 'IN POSITION';

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
  plan: TradePlan | null;
  /** What a manual ENTER would trade now (null while a position is open). */
  candidatePlan: TradePlan | null;
  /** Live premium of the open position's strike, when one is open. */
  positionLtp: number | null;
}
