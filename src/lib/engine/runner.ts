/**
 * RefreshAll orchestration (modMain), shared by the server (live Dhan data)
 * and the app's demo mode (simulated data). Data fetching and persistence
 * are injected so this file stays platform-neutral.
 */
import { runBacktest, type BacktestResult } from './backtest.ts';
import {
  buildTradePlan,
  canTakeNewTrade,
  closeOpenPosition,
  isWithinMarketHours,
  openTrade,
  positionLabel,
  runCycle,
} from './decision.ts';
import { findStrike, legOf } from './indicators.ts';
import { catalogEntry, CATALOG } from './catalog.ts';
import { buildFuturesPlan } from './futures.ts';
import { sizingCapital, type SizingConfig } from './sizing.ts';
import {
  DEFAULT_CONFIG,
  sideOf,
  type Direction,
  type OptionSide,
  initialEngineState,
  type Candle,
  type ChainSnapshot,
  type Dashboard,
  type EngineConfig,
  type EngineEvent,
  type EngineState,
  type LiveLegs,
  type TradePlan,
  type CycleLogRow,
  type JournalRow,
  type OpenPosition,
} from './types.ts';

/** The MCX futures contract the engine is trading (current month, rolled before expiry). */
export interface FuturesContract {
  securityId: string;
  expiry: string;
  tradingSymbol: string;
  tickSize?: number;
}

export interface EngineDataSource {
  /**
   * Fetch 5-min candles + the option chain for the configured underlying.
   * For MCX futures the chain has no strikes (spot = the future's LTP) and
   * the resolved contract is returned alongside.
   */
  load(
    cfg: EngineConfig,
    now: number,
  ): Promise<{ candles: Candle[]; chain: ChainSnapshot; contract?: FuturesContract }>;
  /** Clock used for the cycle (demo mode runs on simulated time). */
  now?(): number;
  /** Demo sources ignore market hours. */
  alwaysOpen?: boolean;
}

export interface EngineStore {
  load(): Promise<{ state?: EngineState; config?: Partial<EngineConfig> } | null>;
  save(state: EngineState, config: EngineConfig): Promise<void>;
}

/** What the app receives (state minus the bulky IV history). */
export const CYCLE_LOG_MAX = 3000;
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface EngineExport {
  exportedAt: number;
  config: EngineConfig;
  journal: JournalRow[];
  events: EngineEvent[];
  cycleLog: CycleLogRow[];
  position: OpenPosition | null;
  realizedToday: number;
  tradesToday: number;
}

export interface LivePnl {
  /** Latest price of the open position (fast ticker, else the last refresh). */
  ltp: number | null;
  /** When that price was taken (ms). */
  at: number | null;
  /** 'TICK' = live quote between refreshes; 'REFRESH' = from the last engine cycle. */
  source: 'TICK' | 'REFRESH' | null;
  /** Open trade P&L incl. the half booked at T1 (null without a position). */
  tradePnl: number | null;
  /** Unbooked part only (what realizedToday doesn't include yet). */
  openPnl: number | null;
  realizedToday: number;
  /** realizedToday + openPnl. */
  dayPnl: number;
  /** Capital in the open trade at entry (entry × qty × ₹/point), for a % figure. */
  invested: number | null;
}

/** P&L of an open position at `ltp`: the unbooked part and the whole trade (incl. booked half). */
export function positionPnl(p: OpenPosition, ltp: number): { open: number; trade: number } {
  const open = (p.side ?? 1) * (ltp - p.entry) * p.remainingQty * (p.pointValue ?? 1);
  return { open, trade: open + p.partialPnl };
}

export interface EngineSnapshot {
  config: EngineConfig;
  state: Omit<EngineState, 'ivHistory'> & { ivSnapshots: number };
  dashboard: Dashboard | null;
  status: string;
  /** Persistent warning banner (Dashboard F4), e.g. expired Dhan token. */
  banner: string;
  lastRefresh: number | null;
  /** Latest 5-min closes for the chart. */
  closes: number[];
  marketOpen: boolean;
  demo: boolean;
  /** Running P&L: today's realized, the open trade at the latest price, and their total. */
  live: LivePnl;
  /** Capital-based sizing: the capital a trade may use now (CAPITAL mode only). */
  capital?: { capital: number; base: number; source: string; funds: number | null };
}

const roundTick = (p: number, tick = 0.05) => Number((Math.round(p / tick) * tick).toFixed(4));

/** Limit prices must be positive and on the instrument's tick (0.05 for options). */
export function validateLimit(limit: number, tick = 0.05) {
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('Enter a valid price');
  if (Math.abs(roundTick(limit, tick) - limit) > 1e-9) throw new Error(`Price must be in steps of ${tick}`);
}

export function sanitizeConfig(patch: Partial<EngineConfig>, base: EngineConfig): EngineConfig {
  const next: EngineConfig = { ...base };
  // Instrument first: its catalog values load, then any explicit values in the same patch win.
  if (patch.symbol !== undefined) {
    const sym = String(patch.symbol).trim().toUpperCase() || 'NIFTY';
    const entry = catalogEntry(sym);
    if (!entry) throw new Error(`Unknown instrument ${sym} (choose one of ${CATALOG.map((c) => c.symbol).join(', ')})`);
    if (sym !== base.symbol) {
      // Switching instrument loads that instrument's full settings (ApplyIndexPreset, extended).
      Object.assign(next, {
        symbol: entry.symbol,
        instrumentKind: entry.kind,
        underlyingSecurityId: entry.underlyingSecurityId,
        underlyingSegment: entry.underlyingSegment,
        tradeSegment: entry.tradeSegment,
        strikeInterval: entry.strikeInterval,
        lotSize: entry.lotSize,
        pointValue: entry.pointValue,
        tickSize: entry.tickSize,
        session: entry.session,
        maxLots: entry.maxLots,
        expiry: '',
        futSecurityId: '',
        futExpiry: '',
        futTradingSymbol: '',
      });
    }
  }
  const num = (k: keyof EngineConfig, min: number, max: number) => {
    const v = (patch as Record<string, unknown>)[k];
    if (v === undefined) return;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${k} must be between ${min} and ${max}`);
    (next as unknown as Record<string, number>)[k] = n;
  };
  num('confHigh', 0, 105);
  num('confWatch', 0, 105);
  num('rrTarget', 0.1, 20);
  num('maxRisk', 1, 10_000_000);
  num('lotSize', 1, 100_000);
  num('atrMult', 0.1, 20);
  num('maxTradesPerDay', 0, 100);
  num('maxDailyLoss', 0, 100_000_000);
  num('strikeInterval', 0, 10_000);
  num('underlyingSecurityId', 0, 1e9);
  num('refreshSeconds', 15, 3600);
  if (patch.autoRefresh !== undefined) next.autoRefresh = !!patch.autoRefresh;
  if (patch.alertsEnabled !== undefined) next.alertsEnabled = !!patch.alertsEnabled;
  if (patch.tradeMode !== undefined) {
    if (patch.tradeMode !== 'PAPER' && patch.tradeMode !== 'LIVE') throw new Error('tradeMode must be PAPER or LIVE');
    next.tradeMode = patch.tradeMode;
  }
  if (patch.liveProduct !== undefined) {
    if (patch.liveProduct !== 'INTRADAY' && patch.liveProduct !== 'MARGIN')
      throw new Error('liveProduct must be INTRADAY or MARGIN');
    next.liveProduct = patch.liveProduct;
  }
  for (const k of ['lastEntryTime', 'lastEntryTimeMcx'] as const) {
    if (patch[k] === undefined) continue;
    const v = String(patch[k]).trim();
    const m = /^(\d{1,2}):(\d{2})$/.exec(v);
    if (v && (!m || Number(m[1]) > 23 || Number(m[2]) > 59)) throw new Error('Entry cutoff must be HH:MM (24-hour, IST) or blank');
    next[k] = m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
  }
  if (patch.expiry !== undefined) {
    const e = String(patch.expiry).trim();
    if (e && !/^\d{4}-\d{2}-\d{2}$/.test(e)) throw new Error('expiry must be YYYY-MM-DD or blank');
    next.expiry = e;
  }
  if (patch.underlyingSegment !== undefined)
    next.underlyingSegment = String(patch.underlyingSegment).trim().toUpperCase();
  num('pointValue', 0.0001, 10_000_000);
  num('tickSize', 0.0001, 1000);
  num('maxLots', 0, 1000);
  if (patch.sizingMode !== undefined) {
    if (patch.sizingMode !== 'RISK' && patch.sizingMode !== 'CAPITAL') throw new Error('sizingMode must be RISK or CAPITAL');
    next.sizingMode = patch.sizingMode;
  }
  num('capitalPaper', 0, 1e11);
  num('capitalLive', 0, 1e11);
  num('capitalPct', 1, 100);
  num('marginPerLot', 0, 1e9);
  num('minPremium', 0, 100_000);
  num('maxStopPct', 0, 100);
  if (patch.profitLock !== undefined) next.profitLock = !!patch.profitLock;
  num('lockStart', 1, 1e10);
  num('lockStep', 1, 1e10);
  num('lockRideFrom', 0, 1e10);
  num('lockRideAmount', 0, 1e10);
  if (next.lockRideFrom > 0 && next.lockRideFrom < next.lockStart)
    throw new Error('The ride level must be at least the lock start (or 0 to keep stepping)');
  num('rollDays', 0, 30);
  if (patch.futSecurityId !== undefined) {
    const id = String(patch.futSecurityId).trim();
    if (id && !/^\d+$/.test(id)) throw new Error('Futures security id must be a number');
    next.futSecurityId = id;
  }
  if (patch.futExpiry !== undefined) next.futExpiry = String(patch.futExpiry).trim();
  if (patch.futTradingSymbol !== undefined) next.futTradingSymbol = String(patch.futTradingSymbol).trim();
  if (next.confWatch > next.confHigh) throw new Error('Watch threshold must not exceed the trade threshold');
  return next;
}

export class EngineRunner {
  state: EngineState = initialEngineState();
  config: EngineConfig = { ...DEFAULT_CONFIG };
  dashboard: Dashboard | null = null;
  status = 'Not refreshed yet';
  banner = '';
  lastRefresh: number | null = null;
  candles: Candle[] = [];
  /** Option chain from the latest cycle (prices for manual entry / exit). */
  lastChain: ChainSnapshot | null = null;
  /**
   * Runs after every successful cycle with the state before and after it —
   * live trading uses it to mirror partial bookings / exits with real orders.
   */
  afterCycle: ((before: EngineState, after: EngineState) => Promise<void>) | null = null;
  /** Dhan available balance (₹), used by CAPITAL sizing in LIVE when live capital is 0. */
  funds: number | null = null;
  /** Latest quote of the open position between refreshes (fast P&L ticker). */
  mark: { ltp: number; at: number; key: string } | null = null;
  private lastLoggedCandle = 0;
  /** Fetches the live account balance (phone / server with Dhan); null in demo. */
  fundsSource: (() => Promise<number>) | null = null;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private source: EngineDataSource;
  private store: EngineStore;
  private onEvents: (events: EngineEvent[], cfg: EngineConfig) => void;

  constructor(
    source: EngineDataSource,
    store: EngineStore,
    onEvents: (events: EngineEvent[], cfg: EngineConfig) => void = () => {},
  ) {
    this.source = source;
    this.store = store;
    this.onEvents = onEvents;
  }

  async init() {
    const saved = await this.store.load().catch(() => null);
    if (saved?.state) this.state = { ...initialEngineState(), ...saved.state };
    if (saved?.config) this.config = { ...DEFAULT_CONFIG, ...saved.config };
  }

  /** Identifies the open position, so a quote for an old one is never shown. */
  positionKey(): string | null {
    const p = this.state.position;
    return p ? `${p.journalId}|${p.direction}|${p.strike}` : null;
  }

  /** Record a live quote of the open position (display only; stops / targets run on refresh). */
  setMark(ltp: number, at = Date.now(), key = this.positionKey()) {
    if (!(ltp > 0) || !key || key !== this.positionKey()) return;
    this.mark = { ltp, at, key };
  }

  livePnl(): LivePnl {
    const p = this.state.position;
    const realizedToday = this.state.realizedToday;
    if (!p) {
      return { ltp: null, at: null, source: null, tradePnl: null, openPnl: null, realizedToday, dayPnl: realizedToday, invested: null };
    }
    const key = this.positionKey();
    const refreshLtp = this.dashboard?.positionLtp ?? null;
    const tick = this.mark && this.mark.key === key && this.mark.at >= (this.lastRefresh ?? 0) ? this.mark : null;
    const ltp = tick?.ltp ?? (refreshLtp && refreshLtp > 0 ? refreshLtp : null);
    const at = tick?.at ?? this.lastRefresh;
    const invested = p.entry * p.totalQty * (p.pointValue ?? 1);
    if (ltp == null) {
      return { ltp: null, at: null, source: null, tradePnl: null, openPnl: null, realizedToday, dayPnl: realizedToday, invested };
    }
    const { open, trade } = positionPnl(p, ltp);
    return {
      ltp,
      at,
      source: tick ? 'TICK' : 'REFRESH',
      tradePnl: trade,
      openPnl: open,
      realizedToday,
      dayPnl: realizedToday + open,
      invested,
    };
  }

  /** Config the plan builders size with (adds the fetched account balance). */
  sizingConfig(): SizingConfig {
    return { ...this.config, availableFunds: this.funds };
  }

  private needsFunds() {
    const c = this.config;
    return c.sizingMode === 'CAPITAL' && c.tradeMode === 'LIVE' && !(c.capitalLive > 0) && !!this.fundsSource;
  }

  /** Refresh the account balance for capital sizing (keeps the last value on failure). */
  async refreshFunds(): Promise<void> {
    if (!this.needsFunds()) return;
    try {
      const f = await this.fundsSource!();
      if (Number.isFinite(f)) this.funds = f;
    } catch {
      /* keep the last balance; sizing shows "not fetched yet" if there never was one */
    }
  }

  private clock() {
    return this.source.now ? this.source.now() : Date.now();
  }

  /** Manual "Refresh Now": always runs, regardless of market hours. */
  refresh(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.doRefresh().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doRefresh() {
    this.status = 'Refreshing...';
    const now = this.clock();
    let data: { candles: Candle[]; chain: ChainSnapshot; contract?: FuturesContract };
    try {
      data = await this.source.load(this.config, now);
      // MCX: remember the resolved current-month contract (and roll it when it changes).
      const k = data.contract;
      if (k && (k.securityId !== this.config.futSecurityId || k.expiry !== this.config.futExpiry)) {
        this.config = {
          ...this.config,
          futSecurityId: k.securityId,
          futExpiry: k.expiry,
          futTradingSymbol: k.tradingSymbol,
          ...(k.tickSize ? { tickSize: k.tickSize } : {}),
        };
      }
      this.banner = '';
    } catch (e) {
      const msg = (e as Error).message;
      this.status = `Error - ${msg}`;
      this.logCycle(now, 'ERROR');
      if (/token|DH-901|401/i.test(msg)) {
        this.banner =
          'Dhan unavailable - token likely expired (tokens expire every 24h). Regenerate in Dhan Web > Profile > DhanHQ Trading APIs.';
      }
      return;
    }
    try {
      const before = this.state;
      await this.refreshFunds();
      const { state, dashboard } = runCycle(this.state, this.sizingConfig(), { ...data, now });
      this.state = state;
      this.dashboard = dashboard;
      this.candles = data.candles;
      this.lastChain = data.chain;
      await this.fillPaperEntry();
      this.status = 'Ready'; // live trading may replace this with a notice below
      if (this.afterCycle) {
        try {
          await this.afterCycle(before, this.state);
        } catch (e) {
          this.status = `Live order error - ${(e as Error).message}`;
        }
      }
      this.lastRefresh = now;
      this.logCycle(now, 'OK');
      // Every event raised during a cycle is stamped with that cycle's clock.
      const fresh = state.events.filter((e) => e.at === now);
      if (fresh.length) this.onEvents(fresh, this.config);
      await this.store.save(this.state, this.config);
    } catch (e) {
      this.status = `Error - ${(e as Error).message}`;
      this.logCycle(now, 'ERROR');
    }
  }

  /**
   * Decision log: keeps a row when the decision / signal / position changes, on each
   * new 5-min candle, and for every error — informative without a row per refresh.
   */
  private logCycle(now: number, result: 'OK' | 'ERROR') {
    const d = result === 'OK' ? this.dashboard : null;
    const p = this.state.position;
    const row: CycleLogRow = {
      at: now,
      symbol: this.config.symbol,
      mode: this.config.tradeMode,
      result,
      spot: d?.market.spot ?? null,
      trend: d?.market.trend ?? '',
      signal: d?.decision.signal ?? '',
      direction: d?.decision.direction ?? '',
      strike: d?.decision.selectedStrike ?? 0,
      confidence: d ? round2(d.decision.confidence) : null,
      scoreUp: d ? round2(d.decision.scoreCE) : null,
      scoreDown: d ? round2(d.decision.scorePE) : null,
      pattern: d?.decision.pattern ?? '',
      pcr: d ? round2(d.chain.pcr) : null,
      ivPercentile: d ? round2(d.decision.ivPercentile) : null,
      factors: d ? d.factors.map((f) => `${f.key}=${round2(f.value)}`).join(' ') : '',
      decision: d?.decision.decisionText ?? '',
      position: p
        ? `${positionLabel(p)} × ${p.remainingQty} @ ${p.entry} SL ${p.currentSl}${d?.positionLtp != null ? ` ltp ${d.positionLtp}` : ''}`
        : '',
      realizedToday: round2(this.state.realizedToday),
      status: this.status,
    };
    const log = this.state.cycleLog ?? [];
    const prev = log[log.length - 1];
    const candle = this.candles[this.candles.length - 1]?.t ?? 0;
    const changed =
      !prev ||
      result === 'ERROR' ||
      prev.result !== result ||
      prev.symbol !== row.symbol ||
      prev.signal !== row.signal ||
      prev.decision !== row.decision ||
      prev.position.split(' ltp ')[0] !== row.position.split(' ltp ')[0] ||
      candle !== this.lastLoggedCandle;
    if (!changed) return;
    this.lastLoggedCandle = candle;
    this.state = { ...this.state, cycleLog: [...log, row].slice(-CYCLE_LOG_MAX) };
  }

  /** Everything worth exporting for review (journal, decision log, events, settings). */
  exportData(): EngineExport {
    return {
      exportedAt: this.clock(),
      config: this.config,
      journal: this.state.journal,
      events: this.state.events,
      cycleLog: this.state.cycleLog ?? [],
      position: this.state.position,
      realizedToday: this.state.realizedToday,
      tradesToday: this.state.tradesToday,
    };
  }

  async updateConfig(patch: Partial<EngineConfig>) {
    const next = sanitizeConfig(patch, this.config);
    if (next.symbol !== this.config.symbol) {
      if (this.state.position) throw new Error('Exit the open position before switching instrument.');
      if (this.state.pendingEntry) throw new Error('Cancel the pending entry order before switching instrument.');
      // Each instrument keeps its own IV history; the pending setup belongs to the old one.
      const bank = { ...(this.state.ivBank ?? {}), [this.config.symbol]: this.state.ivHistory };
      const ivHistory = bank[next.symbol] ?? [];
      delete bank[next.symbol];
      this.state = { ...this.state, ivHistory, ivBank: bank, pending: null };
      this.dashboard = null;
      this.lastChain = null;
      this.candles = [];
    }
    this.config = next;
    await this.refreshFunds();
    // Re-size the ENTER plan right away (capital / risk / lots edits show without a refresh).
    const d = this.dashboard;
    if (d && d.candidatePlan && !this.state.position) {
      d.candidatePlan = this.planFor(d.decision.direction, d.decision.selectedStrike, d.market.atr) ?? d.candidatePlan;
    }
    await this.store.save(this.state, this.config);
    this.syncTimer();
  }

  /** Current price of what a direction trades: the option premium, or the future itself. */
  premium(direction: Direction, strike: number): number | null {
    if (!this.lastChain) return null;
    if (direction === 'LONG' || direction === 'SHORT') return this.lastChain.spot > 0 ? this.lastChain.spot : null;
    const ltp = legOf(findStrike(this.lastChain, strike), direction as OptionSide)?.ltp ?? 0;
    return ltp > 0 ? ltp : null;
  }

  /** Fresh plan for a direction/strike from the latest data (options or futures). */
  private planFor(direction: Direction, strike: number, atr: number): TradePlan | null {
    if (!this.lastChain) return null;
    return direction === 'LONG' || direction === 'SHORT'
      ? buildFuturesPlan(direction, this.lastChain.spot, atr, this.sizingConfig())
      : buildTradePlan(this.lastChain, direction, strike, atr, this.sizingConfig());
  }

  /** Plan a manual ENTER would use now (the dashboard's leading direction + best strike). */
  entryPlan(): TradePlan {
    if (this.state.position) throw new Error('A position is already open — exit it first.');
    const d = this.dashboard;
    if (!d || !this.lastChain) throw new Error('No market data yet — tap Refresh now first.');
    const gate = canTakeNewTrade(this.state, this.config, this.clock());
    if (!gate.ok) throw new Error(gate.reason);
    const plan = d.candidatePlan ?? this.planFor(d.decision.direction, d.decision.selectedStrike, d.market.atr);
    if (!plan || plan.entry <= 0)
      throw new Error(`No price for ${d.decision.direction} ${d.decision.selectedStrike || this.config.symbol}`);
    if (plan.blocked || plan.qty <= 0) throw new Error(plan.blocked ?? 'Position size is 0 lots');
    return plan;
  }

  /**
   * Manual ENTER in paper mode. Without a limit, or with a limit the market has
   * already reached (buy: at/above the price; futures short: at/below), it
   * fills now; otherwise it waits as a pending limit entry for a later refresh.
   */
  async placeEntry(limit?: number) {
    if (this.state.pendingEntry) throw new Error('An entry order is already pending — cancel it first.');
    const plan = this.entryPlan();
    const premium = this.premium(plan.direction, plan.strike) ?? plan.entry;
    const side = sideOf(plan.direction);
    if (limit == null || side * (limit - premium) >= 0) return this.manualEnter({ plan, entry: premium });
    validateLimit(limit, this.config.tickSize);
    this.state = {
      ...this.state,
      pendingEntry: { plan, limit: roundTick(limit, this.config.tickSize), placedAt: this.clock() },
    };
    await this.store.save(this.state, this.config);
    return null;
  }

  /** Paper: cancel the pending limit entry. */
  async cancelPendingEntry() {
    if (this.state.pendingEntry?.live) throw new Error('Live entry orders are cancelled through Dhan');
    await this.setPendingEntry(null);
  }

  /** Record a pending limit entry (used by live trading after placing the Dhan order). */
  async setPendingEntry(p: NonNullable<EngineState['pendingEntry']> | null) {
    this.state = { ...this.state, pendingEntry: p };
    await this.store.save(this.state, this.config);
  }

  /** Paper: fill the pending limit entry once the premium has come down to it. */
  private async fillPaperEntry() {
    const pe = this.state.pendingEntry;
    if (!pe || pe.live) return;
    if (this.state.position) return this.setPendingEntry(null);
    const premium = this.premium(pe.plan.direction, pe.plan.strike);
    // Buy fills when the price comes down to the limit; a futures short when it rises to it.
    if (premium != null && sideOf(pe.plan.direction) * (pe.limit - premium) >= 0) {
      await this.manualEnter({
        plan: pe.plan,
        entry: premium,
        reason: `Limit entry filled (limit ${pe.limit.toFixed(2)})`,
      });
    }
  }

  /** Open a position from a manual ENTER (paper at LTP, or live at the actual fill). */
  async manualEnter(opts: { entry?: number; qty?: number; live?: LiveLegs; plan?: TradePlan; reason?: string } = {}) {
    const plan = opts.plan ?? this.entryPlan();
    const d = this.dashboard!;
    const now = this.clock();
    const next: EngineState = JSON.parse(JSON.stringify(this.state));
    openTrade(next, this.config, {
      direction: plan.direction,
      plan,
      entry: opts.entry ?? plan.entry,
      qty: opts.qty ?? plan.qty,
      now,
      spot: d.market.spot,
      confidence: d.decision.confidence,
      trend: d.market.trend,
      pcr: d.chain.pcr,
      oiBias: d.decision.oiStrength,
      iv: d.greeks.iv,
      delta: d.greeks.delta,
      reason: `${opts.live ? 'Manual LIVE entry' : 'Manual entry'}${opts.reason ? ` · ${opts.reason}` : ''}: ${d.decision.decisionText} | Confidence ${d.decision.confidence.toFixed(2)}/100`,
    });
    next.pendingEntry = null;
    if (opts.live && next.position) next.position.live = opts.live;
    this.state = next;
    if (this.dashboard) {
      // Reflect the new position immediately, without waiting for the next refresh.
      this.dashboard = {
        ...this.dashboard,
        decision: {
          ...this.dashboard.decision,
          signal: 'IN POSITION',
          decisionText: 'POSITION OPEN - monitoring for SL/Target',
        },
        candidatePlan: null,
        positionLtp: next.position!.entry,
      };
    }
    this.onEvents(
      next.events.filter((e) => e.at === now),
      this.config,
    );
    await this.store.save(this.state, this.config);
    return this.state.position!;
  }

  /** Close the open position (manual EXIT at LTP / live fill, or an exchange stop that filled). */
  async manualExit(opts: { price?: number; reason?: string } = {}) {
    const p = this.state.position;
    if (!p) throw new Error('No open position.');
    const price = opts.price ?? this.premium(p.direction, p.strike);
    if (!price) throw new Error(`No premium for ${p.direction} ${p.strike} — tap Refresh now first.`);
    const now = this.clock();
    const next: EngineState = JSON.parse(JSON.stringify(this.state));
    closeOpenPosition(next, price, opts.reason ?? 'MANUAL EXIT', now);
    this.state = next;
    const d = this.dashboard;
    if (d && this.lastChain) {
      this.dashboard = {
        ...d,
        decision: {
          ...d.decision,
          signal: 'NO TRADE',
          decisionText: `POSITION CLOSED - ${opts.reason ?? 'MANUAL EXIT'} @ ${price.toFixed(2)}`,
        },
        candidatePlan: this.planFor(d.decision.direction, d.decision.selectedStrike, d.market.atr),
        positionLtp: null,
      };
    }
    this.onEvents(
      next.events.filter((e) => e.at === now),
      this.config,
    );
    await this.store.save(this.state, this.config);
  }

  /**
   * Replace a closed trade's exit with the real fill (live mode): the engine
   * books exits at the SL/target level, the exchange may fill elsewhere.
   * `leg` is the position as it was just before the final exit.
   */
  async amendExit(leg: NonNullable<EngineState['position']>, fillPrice: number, note: string) {
    const next: EngineState = JSON.parse(JSON.stringify(this.state));
    const j = next.journal.find((x) => x.id === leg.journalId);
    if (!j || j.exit == null) return;
    const oldLeg = (j.exit - leg.entry) * leg.remainingQty;
    const newLeg = (fillPrice - leg.entry) * leg.remainingQty;
    j.exit = fillPrice;
    j.pnl = leg.partialPnl + newLeg;
    j.exitReason = `${j.exitReason} · ${note} @ ${fillPrice.toFixed(2)}`;
    next.realizedToday += newLeg - oldLeg;
    this.state = next;
    await this.store.save(this.state, this.config);
  }

  /** Persist an in-place edit of the open position (e.g. a new stop-loss order id). */
  async patchPosition(patch: Partial<NonNullable<EngineState['position']>>) {
    if (!this.state.position) return;
    this.state = { ...this.state, position: { ...this.state.position, ...patch } };
    await this.store.save(this.state, this.config);
  }

  async resetJournal() {
    // Clears trades and counters; the decision log is kept (export it any time).
    this.state = { ...initialEngineState(), ivHistory: this.state.ivHistory, cycleLog: this.state.cycleLog };
    await this.store.save(this.state, this.config);
  }

  backtest(): BacktestResult {
    return runBacktest(this.candles, this.config);
  }

  marketOpen() {
    return this.source.alwaysOpen || isWithinMarketHours(this.clock(), this.config.session);
  }

  /** Auto refresh loop (StartAutoRefresh / AutoRefreshTick), gated to market hours. */
  syncTimer(tickMs = 1000) {
    if (!this.config.autoRefresh) {
      this.stop();
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => {
      const secs = Math.max(15, this.config.refreshSeconds);
      if (this.running) return;
      if (this.lastRefresh && this.clock() - this.lastRefresh < secs * 1000 && !this.source.alwaysOpen) return;
      if (!this.marketOpen()) {
        this.status = 'Market Closed (auto-refresh paused)';
        return;
      }
      void this.refresh();
    }, tickMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(demo = false): EngineSnapshot {
    // The decision log is exported on request, not shipped with every poll.
    const { ivHistory, cycleLog: _log, ...rest } = this.state;
    return {
      config: this.config,
      state: { ...rest, ivSnapshots: ivHistory.length },
      dashboard: this.dashboard,
      status: this.status,
      banner: this.banner,
      lastRefresh: this.lastRefresh,
      closes: this.candles.slice(-150).map((c) => c.c),
      marketOpen: this.marketOpen(),
      demo,
      live: this.livePnl(),
      ...(this.config.sizingMode === 'CAPITAL'
        ? { capital: { ...sizingCapital(this.sizingConfig()), funds: this.funds } }
        : {}),
    };
  }
}
