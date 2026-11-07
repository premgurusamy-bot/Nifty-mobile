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
import { blankSymbolState, isBusy, normalizeSymbolState, pickSymbolState, runMultiCycle, splitFactor } from './multi.ts';
import {
  DEFAULT_CONFIG,
  MAX_FIXED_STOP_PCT,
  MIN_REFRESH_SECONDS,
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
  type SymbolState,
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

export interface WatchItem {
  symbol: string;
  label: string;
  active: boolean;
  inTrade: boolean;
  /** The index's open trade: what, how many, entry and its P&L (incl. the T1 half). */
  trade?: { label: string; qty: number; entry: number; pnl: number | null };
  pendingEntry?: boolean;
  confidence: number | null;
  signal: string;
  direction: string;
  strike: number;
  decision: string;
  spot: number | null;
  error?: string;
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
  /** realizedToday + openPnl (+ the other indexes' open trades, multi-index). */
  dayPnl: number;
  /** Multi-index: open P&L of trades on the other indexes (last refresh), and how many. */
  othersPnl?: number;
  othersCount?: number;
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
  /** Multi-index: every watched index at a glance (absent when off). */
  watch?: WatchItem[];
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
  num('confirmHoldMinutes', 0, 60);
  if (patch.confirmRising !== undefined) next.confirmRising = !!patch.confirmRising;
  num('rrTarget', 0.1, 20);
  num('maxRisk', 1, 10_000_000);
  num('lotSize', 1, 100_000);
  num('atrMult', 0.1, 20);
  num('maxTradesPerDay', 0, 100);
  num('maxDailyLoss', 0, 100_000_000);
  num('strikeInterval', 0, 10_000);
  num('underlyingSecurityId', 0, 1e9);
  num('refreshSeconds', MIN_REFRESH_SECONDS, 3600);
  if (patch.autoRefresh !== undefined) next.autoRefresh = !!patch.autoRefresh;
  if (patch.autoEntryPaper !== undefined) next.autoEntryPaper = !!patch.autoEntryPaper;
  if (patch.multiIndex !== undefined) next.multiIndex = !!patch.multiIndex;
  if (patch.watchSymbols !== undefined) {
    const list = [...new Set((patch.watchSymbols ?? []).map((x) => String(x).toUpperCase()))];
    for (const x of list)
      if (catalogEntry(x)?.kind !== 'INDEX_OPTIONS') throw new Error(`${x} can't be watched in multi-index mode (index options only)`);
    if (!list.length) throw new Error('Watch at least one index');
    next.watchSymbols = list;
  }
  delete next.watchOnly; // runtime only
  if (patch.autoEntryLive !== undefined) next.autoEntryLive = !!patch.autoEntryLive;
  if (patch.alertsEnabled !== undefined) next.alertsEnabled = !!patch.alertsEnabled;
  if (patch.tradeMode !== undefined) {
    if (patch.tradeMode !== 'PAPER' && patch.tradeMode !== 'LIVE') throw new Error('tradeMode must be PAPER or LIVE');
    // Every switch into LIVE starts with manual entries: automatic live trading is a separate, explicit choice.
    if (patch.tradeMode === 'LIVE' && next.tradeMode !== 'LIVE' && patch.autoEntryLive === undefined) next.autoEntryLive = false;
    next.tradeMode = patch.tradeMode;
  }
  if (patch.multiSize !== undefined) {
    if (patch.multiSize !== 'SPLIT' && patch.multiSize !== 'FULL') throw new Error('multiSize must be SPLIT or FULL');
    next.multiSize = patch.multiSize;
  }
  if (patch.entryFillSeconds !== undefined) {
    const v = Number(patch.entryFillSeconds);
    if (!Number.isFinite(v) || v < 1 || v > 30) throw new Error('Entry fill wait must be 1–30 seconds');
    next.entryFillSeconds = Math.round(v);
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
    if (patch.sizingMode !== 'RISK' && patch.sizingMode !== 'CAPITAL' && patch.sizingMode !== 'FIXED')
      throw new Error('sizingMode must be RISK, CAPITAL or FIXED');
    next.sizingMode = patch.sizingMode;
  }
  num('capitalPaper', 0, 1e11);
  num('capitalLive', 0, 1e11);
  num('capitalPct', 1, 100);
  num('fixedLots', 1, 1000);
  if (!Number.isInteger(next.fixedLots)) throw new Error('Fixed lots must be a whole number');
  num('fixedStopPct', 1, MAX_FIXED_STOP_PCT);
  num('marginPerLot', 0, 1e9);
  num('minPremium', 0, 100_000);
  num('maxStopPct', 0, 100);
  if (patch.profitLock !== undefined) next.profitLock = !!patch.profitLock;
  num('lockStart', 1, 1e10);
  num('lockStep', 1, 1e10);
  num('lockRideFrom', 0, 1e10);
  num('lockRideAmount', 0, 1e10);
  if (patch.dayPlanLock !== undefined) next.dayPlanLock = !!patch.dayPlanLock;
  for (const k of ['dl1At', 'dl1Lock', 'dl2At', 'dl2Lock', 'dl3At', 'dl3Lock', 'dayFloor'] as const) num(k, 0, 1e10);
  if (!(next.dl1At < next.dl2At && next.dl2At < next.dl3At))
    throw new Error('Day plan: the best-profit steps must rise (e.g. 9,000 < 12,000 < 14,000)');
  if (!(next.dl1Lock <= next.dl2Lock && next.dl2Lock <= next.dl3Lock))
    throw new Error('Day plan: the secured amounts must not fall from one step to the next');
  for (const [at, lock] of [[next.dl1At, next.dl1Lock], [next.dl2At, next.dl2Lock], [next.dl3At, next.dl3Lock]])
    if (lock >= at) throw new Error('Day plan: each secured amount must be below its best-profit step');
  if (patch.lossTrail !== undefined) next.lossTrail = !!patch.lossTrail;
  for (const k of ['lt1At', 'lt1Loss', 'lt2At', 'lt2Loss'] as const) num(k, 0, 1e10);
  if (!(next.lt1At > 0 && next.lt1At < next.lt2At))
    throw new Error('Loss trail: step 2 profit must be above step 1 (e.g. 5,000 < 8,500)');
  if (next.lt2Loss > next.lt1Loss)
    throw new Error('Loss trail: the allowed loss must not grow from step 1 to step 2');
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

/** Current settings revision: 1 = hold before entry 5 → 3 minutes. */
export const CONFIG_REV = 1;

/**
 * One-time updates to saved settings. Rev 1: the hold-before-entry default changed from 5 to 3
 * minutes; a saved 5 (the old default) becomes 3, any other value you chose is kept.
 */
export function migrateConfig(cfg: EngineConfig, saved: Partial<EngineConfig>): EngineConfig {
  const rev = saved.configRev ?? 0;
  const next = { ...cfg, configRev: CONFIG_REV };
  if (rev < 1 && saved.confirmHoldMinutes === 5) next.confirmHoldMinutes = 3;
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
  private lastSaveAt = 0;
  /** Multi-index: the latest dashboard / data of every watched index, and load errors. */
  multiDash: Record<string, Dashboard> = {};
  private multiData: Record<string, { candles: Candle[]; chain: ChainSnapshot }> = {};
  multiErrors: Record<string, string> = {};
  /** Multi-index: the index you picked to look at / ENTER on (until a trade opens). */
  private pinnedActive: string | null = null;
  private lastSaveKey = '';
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
    if (saved?.config) this.config = migrateConfig({ ...DEFAULT_CONFIG, ...saved.config }, saved.config);
  }

  // ---------------------------------------------------------------- multi-index

  /** Multi-index is on and there are several index-option instruments to watch. */
  multiActive(): boolean {
    const c = this.config;
    return !!c.multiIndex && c.instrumentKind === 'INDEX_OPTIONS' && this.watchList().length >= 2;
  }

  watchList(): string[] {
    return (this.config.watchSymbols ?? []).filter((s) => catalogEntry(s)?.kind === 'INDEX_OPTIONS');
  }

  /** The engine settings for one watched index: its own contract preset, your strategy settings. */
  private cfgFor(symbol: string): SizingConfig {
    const base = symbol === this.config.symbol ? this.config : sanitizeConfig({ symbol }, this.config);
    return { ...base, availableFunds: this.funds };
  }

  /** Save, with the active index's per-index state written back into the watch map first. */
  private async persist() {
    this.stash();
    await this.store.save(this.state, this.config);
  }

  /** Multi-index: copy the active index's state (trade, setup, …) into its watch entry. */
  private stash() {
    if (this.state.watch) this.state = { ...this.state, watch: { ...this.state.watch, [this.config.symbol]: pickSymbolState(this.state) } };
  }

  /** Show / act on one watched index (no stash: the caller has done that). */
  private focus(symbol: string, base: EngineConfig = this.config) {
    const w = this.state.watch ?? {};
    const own = w[symbol] ? normalizeSymbolState(w[symbol]) : blankSymbolState(this.state.ivBank?.[symbol] ?? []);
    this.state = { ...this.state, ...own, watch: { ...w, [symbol]: own } };
    this.config = symbol === base.symbol ? base : sanitizeConfig({ symbol }, base);
    this.dashboard = this.multiDash[symbol] ?? null;
    this.lastChain = this.multiData[symbol]?.chain ?? null;
    this.candles = this.multiData[symbol]?.candles ?? [];
  }

  /** Make a watched index the active one (its per-index state mirrored into the main state). */
  private useWatched(symbol: string) {
    this.stash();
    this.focus(symbol);
  }

  /** Multi-index: per-index state of every watched index, the active one current. */
  private watchStates(): Record<string, SymbolState> {
    const w: Record<string, SymbolState> = {};
    for (const [sym, st] of Object.entries(this.state.watch ?? {})) w[sym] = normalizeSymbolState(st);
    if (this.state.watch) w[this.config.symbol] = pickSymbolState(this.state);
    return w;
  }

  /** Back to one index: the others' IV histories go to the bank, the per-index map is dropped. */
  private leaveMulti(keep: string) {
    this.stash();
    const w = this.state.watch ?? {};
    const busy = Object.entries(w).find(([sym, st]) => sym !== keep && isBusy(st));
    if (busy) throw new Error(`${busy[0]} still has an open trade or entry order — close it before leaving multi-index.`);
    const bank = { ...(this.state.ivBank ?? {}) };
    for (const [sym, st] of Object.entries(w)) if (sym !== keep) bank[sym] = st.ivHistory;
    const own = w[keep];
    delete bank[keep];
    const { watch: _w, ...rest } = this.state;
    this.state = { ...rest, ...(own ?? {}), ivBank: bank } as EngineState;
    this.multiDash = {};
    this.multiData = {};
    this.multiErrors = {};
    this.pinnedActive = null;
  }

  /** Multi-index: look at / ENTER / EXIT on this watched index (each keeps its own trade). */
  async setActive(symbol: string) {
    if (!this.multiActive() || !this.watchList().includes(symbol)) throw new Error(`${symbol} is not being watched`);
    this.useWatched(symbol);
    this.pinnedActive = symbol;
    await this.persist();
  }

  private async doMultiRefresh(now: number) {
    const symbols = this.watchList();
    if (!this.state.watch) {
      // Starting multi-index: the current index keeps its state, the others start from their IV banks.
      const w: Record<string, SymbolState> = {};
      for (const sym of symbols)
        w[sym] = sym === this.config.symbol ? pickSymbolState(this.state) : blankSymbolState(this.state.ivBank?.[sym] ?? []);
      this.state = { ...this.state, watch: w };
    }
    this.stash();
    const data: Record<string, { candles: Candle[]; chain: ChainSnapshot }> = {};
    const loadErr: Record<string, string> = {};
    for (const sym of symbols) {
      try {
        const d = await this.source.load(this.cfgFor(sym), now);
        data[sym] = { candles: d.candles, chain: d.chain };
      } catch (e) {
        loadErr[sym] = (e as Error).message;
      }
    }
    if (!Object.keys(data).length) {
      const msg = Object.values(loadErr)[0] ?? 'no data';
      this.status = `Error - ${msg}`;
      this.logCycle(now, 'ERROR');
      if (/token|DH-901|401/i.test(msg)) {
        this.banner =
          'Dhan unavailable - token likely expired (tokens expire every 24h). Regenerate in Dhan Web > Profile > DhanHQ Trading APIs.';
      }
      return;
    }
    this.banner = '';
    const prevActive = this.config.symbol;
    const base = this.config;
    try {
      const before = this.state;
      const beforeWatch = this.watchStates();
      await this.refreshFunds();
      const res = runMultiCycle(this.state, this.state.watch!, symbols, (s) => this.cfgFor(s), data, now);
      this.multiDash = res.dashboards;
      this.multiData = data;
      this.multiErrors = { ...loadErr, ...res.errors };
      this.state = { ...res.shared, ...res.watch[prevActive], watch: res.watch };
      // Paper limit fills and live orders, one index at a time (trades first, then highest score:
      // the higher score's entry order goes in first). Each index's market order is filled or
      // cancelled within the fill window, so the next one never waits long.
      const liveNotes: string[] = [];
      for (const sym of res.order) {
        this.focus(sym, base);
        await this.fillPaperEntry();
        if (this.afterCycle) {
          this.status = 'Ready';
          try {
            await this.afterCycle({ ...before, ...(beforeWatch[sym] ?? blankSymbolState()) }, this.state);
          } catch (e) {
            this.status = `Live order error - ${(e as Error).message}`;
          }
          if (this.status !== 'Ready') liveNotes.push(`${sym}: ${this.status}`);
        }
        this.stash();
      }
      // Which index the Dashboard and ENTER use: stay on one with a trade, else go to a new entry, …
      const w = this.state.watch!;
      const conf = (s: string) => res.dashboards[s]?.decision.confidence ?? -1;
      const busy = symbols.filter((s) => isBusy(w[s]));
      const justEntered = res.entered.find((s) => isBusy(w[s]));
      let active = prevActive;
      if (isBusy(w[prevActive])) active = prevActive; // you're watching a trade: stay (alerts tell about the other)
      else if (justEntered) active = justEntered;
      else if (busy.length) active = busy[0];
      else if (this.pinnedActive && res.dashboards[this.pinnedActive]) active = this.pinnedActive;
      else {
        const best = symbols.filter((s) => res.dashboards[s]).sort((a, b) => conf(b) - conf(a))[0];
        // Small hysteresis so the view doesn't flip on every refresh.
        if (best && (!res.dashboards[active] || conf(best) >= conf(active) + 2)) active = best;
      }
      if (res.entered.length) this.pinnedActive = null;
      this.focus(active, base);
      const errs = Object.entries(this.multiErrors).map(([s, m]) => `${s}: ${m}`);
      this.status = liveNotes.length
        ? liveNotes.join(' · ')
        : errs.length
          ? `Ready · ${errs.join(' · ')}`
          : 'Ready';
      this.lastRefresh = now;
      this.logCycle(now, 'OK');
      const fresh = this.state.events.filter((e) => e.at === now);
      if (fresh.length) this.onEvents(fresh, this.config);
      await this.saveAfterCycle(now);
    } catch (e) {
      this.focus(prevActive, base);
      this.status = `Error - ${(e as Error).message}`;
      this.logCycle(now, 'ERROR');
    }
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

  /** Multi-index: open P&L of the trades on the other (not shown) indexes, at their last refresh. */
  private othersOpenPnl(): { pnl: number; count: number } {
    if (!this.state.watch) return { pnl: 0, count: 0 };
    let pnl = 0;
    let count = 0;
    for (const [sym, w] of Object.entries(this.state.watch)) {
      if (sym === this.config.symbol || !w.position) continue;
      count++;
      const ltp = this.multiDash[sym]?.positionLtp;
      if (ltp != null && ltp > 0) pnl += positionPnl(w.position, ltp).open;
    }
    return { pnl, count };
  }

  livePnl(): LivePnl {
    const p = this.state.position;
    const others = this.othersOpenPnl();
    const realizedToday = this.state.realizedToday;
    const extra = others.count ? { othersPnl: others.pnl, othersCount: others.count } : {};
    const dayBase = realizedToday + others.pnl;
    if (!p) {
      return { ltp: null, at: null, source: null, tradePnl: null, openPnl: null, realizedToday, dayPnl: dayBase, invested: null, ...extra };
    }
    const key = this.positionKey();
    const refreshLtp = this.dashboard?.positionLtp ?? null;
    const tick = this.mark && this.mark.key === key && this.mark.at >= (this.lastRefresh ?? 0) ? this.mark : null;
    const ltp = tick?.ltp ?? (refreshLtp && refreshLtp > 0 ? refreshLtp : null);
    const at = tick?.at ?? this.lastRefresh;
    const invested = p.entry * p.totalQty * (p.pointValue ?? 1);
    if (ltp == null) {
      return { ltp: null, at: null, source: null, tradePnl: null, openPnl: null, realizedToday, dayPnl: dayBase, invested, ...extra };
    }
    const { open, trade } = positionPnl(p, ltp);
    return {
      ltp,
      at,
      source: tick ? 'TICK' : 'REFRESH',
      tradePnl: trade,
      openPnl: open,
      realizedToday,
      dayPnl: dayBase + open,
      invested,
      ...extra,
    };
  }

  watchItems(): WatchItem[] {
    const w = this.watchStates();
    return this.watchList().map((sym) => {
      const d = this.multiDash[sym];
      const p = w[sym]?.position ?? null;
      const ltp = p ? (sym === this.config.symbol ? this.livePnl().ltp : (d?.positionLtp ?? null)) : null;
      return {
        symbol: sym,
        label: catalogEntry(sym)?.label ?? sym,
        active: sym === this.config.symbol,
        inTrade: !!p,
        ...(p ? { trade: { label: positionLabel(p), qty: p.remainingQty, entry: p.entry, pnl: ltp != null && ltp > 0 ? positionPnl(p, ltp).trade : null } } : {}),
        ...(w[sym]?.pendingEntry ? { pendingEntry: true } : {}),
        confidence: d ? round2(d.decision.confidence) : null,
        signal: d?.decision.signal ?? '',
        direction: d?.decision.direction ?? '',
        strike: d?.decision.selectedStrike ?? 0,
        decision: d?.decision.decisionText ?? 'Waiting for the first refresh',
        spot: d?.market.spot ?? null,
        ...(this.multiErrors[sym] ? { error: this.multiErrors[sym] } : {}),
      };
    });
  }

  /** Config the plan builders size with (adds the fetched account balance). */
  sizingConfig(): SizingConfig {
    const base: SizingConfig = { ...this.config, availableFunds: this.funds };
    if (!this.state.watch || !this.multiActive()) return base;
    // SPLIT: this trade shares the size with the other indexes' open trades / entries going in now.
    const others = Object.entries(this.state.watch).filter(
      ([sym, w]) => sym !== this.config.symbol && (w.position || w.liveAutoRequest),
    ).length;
    return { ...base, sizeFactor: splitFactor(this.config, others + 1) };
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
    if (this.multiActive()) return this.doMultiRefresh(now);
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
      await this.saveAfterCycle(now);
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
    const multiOn = this.state.watch && next.multiIndex && next.instrumentKind === 'INDEX_OPTIONS';
    if (this.state.watch && !multiOn) this.leaveMulti(next.symbol);
    if (multiOn && next.symbol !== this.config.symbol) {
      // Multi-index: picking an index just makes it the one you look at / ENTER on (trades stay open).
      this.useWatched(next.symbol);
      this.pinnedActive = next.symbol;
    } else if (next.symbol !== this.config.symbol) {
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
    await this.persist();
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
    await this.persist();
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
    await this.persist();
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
  /**
   * Save after a refresh. Anything that matters (trades, stop / lock moves, pending orders,
   * setups, alerts, counters, config) saves at once; otherwise at most every 15 s, so a 3-second
   * refresh doesn't rewrite the whole engine state on the phone every 3 seconds.
   */
  private async saveAfterCycle(now: number) {
    const s = this.state;
    const key = JSON.stringify([
      s.position,
      s.pendingEntry,
      s.pending,
      Object.values(s.watch ?? {}).map((w) => [w.position, w.pendingEntry, w.pending]),
      s.journal.length,
      s.journal.at(-1)?.exit ?? null,
      s.events[0]?.at ?? 0,
      s.tradesToday,
      s.realizedToday,
      s.day,
      s.cycleLog?.length ?? 0,
      this.config,
    ]);
    if (key === this.lastSaveKey && now - this.lastSaveAt < 15_000 && now >= this.lastSaveAt) return;
    this.lastSaveKey = key;
    this.lastSaveAt = now;
    await this.persist();
  }

  /** Take (and clear) this cycle's LIVE automatic-entry request, if any. */
  takeAutoRequest(): string | null {
    const k = this.state.liveAutoRequest ?? null;
    if (k) this.state = { ...this.state, liveAutoRequest: null };
    return k;
  }

  async manualEnter(
    opts: { entry?: number; qty?: number; live?: LiveLegs; plan?: TradePlan; reason?: string; auto?: boolean } = {},
  ) {
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
      reason: `${opts.auto ? 'Auto LIVE entry' : opts.live ? 'Manual LIVE entry' : 'Manual entry'}${opts.reason ? ` · ${opts.reason}` : ''}: ${d.decision.decisionText} | Confidence ${d.decision.confidence.toFixed(2)}/100`,
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
    await this.persist();
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
    await this.persist();
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
    // Direction- and ₹/point-aware (MCX shorts), like the engine's own P&L.
    const k = (leg.side ?? 1) * leg.remainingQty * (leg.pointValue ?? 1);
    const oldLeg = (j.exit - leg.entry) * k;
    const newLeg = (fillPrice - leg.entry) * k;
    j.exit = fillPrice;
    j.pnl = leg.partialPnl + newLeg;
    j.exitReason = `${j.exitReason} · ${note} @ ${fillPrice.toFixed(2)}`;
    next.realizedToday += newLeg - oldLeg;
    this.state = next;
    await this.persist();
  }

  /** Persist an in-place edit of the open position (e.g. a new stop-loss order id). */
  async patchPosition(patch: Partial<NonNullable<EngineState['position']>>) {
    if (!this.state.position) return;
    this.state = { ...this.state, position: { ...this.state.position, ...patch } };
    await this.persist();
  }

  async resetJournal() {
    // Clears trades and counters; the decision log is kept (export it any time).
    this.state = { ...initialEngineState(), ivHistory: this.state.ivHistory, cycleLog: this.state.cycleLog };
    await this.persist();
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
      const secs = Math.max(MIN_REFRESH_SECONDS, this.config.refreshSeconds);
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
    const { ivHistory, cycleLog: _log, watch: _watch, ...rest } = this.state;
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
      ...(this.multiActive() ? { watch: this.watchItems() } : {}),
      ...(this.config.sizingMode === 'CAPITAL'
        ? { capital: { ...sizingCapital(this.sizingConfig()), funds: this.funds } }
        : {}),
    };
  }
}
