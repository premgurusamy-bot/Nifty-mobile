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
  runCycle,
} from './decision.ts';
import { findStrike, legOf } from './indicators.ts';
import {
  DEFAULT_CONFIG,
  INDEX_PRESETS,
  initialEngineState,
  type Candle,
  type ChainSnapshot,
  type Dashboard,
  type EngineConfig,
  type EngineEvent,
  type EngineState,
  type LiveLegs,
  type TradePlan,
} from './types.ts';

export interface EngineDataSource {
  /** Fetch 5-min candles + the option chain for the configured underlying. */
  load(cfg: EngineConfig, now: number): Promise<{ candles: Candle[]; chain: ChainSnapshot }>;
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
}

export function sanitizeConfig(patch: Partial<EngineConfig>, base: EngineConfig): EngineConfig {
  const next: EngineConfig = { ...base };
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
  num('strikeInterval', 1, 10_000);
  num('underlyingSecurityId', 1, 1e9);
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
  if (patch.expiry !== undefined) {
    const e = String(patch.expiry).trim();
    if (e && !/^\d{4}-\d{2}-\d{2}$/.test(e)) throw new Error('expiry must be YYYY-MM-DD or blank');
    next.expiry = e;
  }
  if (patch.underlyingSegment !== undefined)
    next.underlyingSegment = String(patch.underlyingSegment).trim().toUpperCase();
  if (patch.symbol !== undefined) {
    const sym = String(patch.symbol).trim().toUpperCase() || 'NIFTY';
    next.symbol = sym;
    // ApplyIndexPreset: known indices get confirmed ids; changing symbol without a preset must set ids explicitly.
    const preset = INDEX_PRESETS[sym];
    if (preset && sym !== base.symbol)
      Object.assign(next, preset, pickDefined(patch, ['strikeInterval', 'underlyingSecurityId', 'underlyingSegment']));
  }
  if (next.confWatch > next.confHigh) throw new Error('Watch threshold must not exceed the trade threshold');
  return next;
}

function pickDefined(o: Partial<EngineConfig>, keys: (keyof EngineConfig)[]) {
  const out: Partial<EngineConfig> = {};
  for (const k of keys) if (o[k] !== undefined) (out as Record<string, unknown>)[k] = o[k];
  return out;
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
    let data: { candles: Candle[]; chain: ChainSnapshot };
    try {
      data = await this.source.load(this.config, now);
      this.banner = '';
    } catch (e) {
      const msg = (e as Error).message;
      this.status = `Error - ${msg}`;
      if (/token|DH-901|401/i.test(msg)) {
        this.banner =
          'Dhan unavailable - token likely expired (tokens expire every 24h). Regenerate in Dhan Web > Profile > DhanHQ Trading APIs.';
      }
      return;
    }
    try {
      const before = this.state;
      const { state, dashboard } = runCycle(this.state, this.config, { ...data, now });
      this.state = state;
      this.dashboard = dashboard;
      this.candles = data.candles;
      this.lastChain = data.chain;
      if (this.afterCycle) {
        try {
          await this.afterCycle(before, this.state);
        } catch (e) {
          this.status = `Live order error - ${(e as Error).message}`;
        }
      }
      this.lastRefresh = now;
      if (!this.status.startsWith('Live order error')) this.status = 'Ready';
      // Every event raised during a cycle is stamped with that cycle's clock.
      const fresh = state.events.filter((e) => e.at === now);
      if (fresh.length) this.onEvents(fresh, this.config);
      await this.store.save(this.state, this.config);
    } catch (e) {
      this.status = `Error - ${(e as Error).message}`;
    }
  }

  async updateConfig(patch: Partial<EngineConfig>) {
    this.config = sanitizeConfig(patch, this.config);
    await this.store.save(this.state, this.config);
    this.syncTimer();
  }

  /** Current premium of a strike from the latest chain. */
  premium(direction: 'CE' | 'PE', strike: number): number | null {
    if (!this.lastChain) return null;
    const ltp = legOf(findStrike(this.lastChain, strike), direction)?.ltp ?? 0;
    return ltp > 0 ? ltp : null;
  }

  /** Plan a manual ENTER would use now (the dashboard's leading direction + best strike). */
  entryPlan(): TradePlan {
    if (this.state.position) throw new Error('A position is already open — exit it first.');
    const d = this.dashboard;
    if (!d || !this.lastChain) throw new Error('No market data yet — tap Refresh now first.');
    const gate = canTakeNewTrade(this.state, this.config);
    if (!gate.ok) throw new Error(gate.reason);
    const plan =
      d.candidatePlan ??
      buildTradePlan(this.lastChain, d.decision.direction, d.decision.selectedStrike, d.market.atr, this.config);
    if (!plan || plan.entry <= 0)
      throw new Error(`No premium for ${d.decision.direction} ${d.decision.selectedStrike}`);
    return plan;
  }

  /** Open a position from a manual ENTER (paper at LTP, or live at the actual fill). */
  async manualEnter(opts: { entry?: number; qty?: number; live?: LiveLegs; plan?: TradePlan } = {}) {
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
      reason: `${opts.live ? 'Manual LIVE entry' : 'Manual entry'}: ${d.decision.decisionText} | Confidence ${d.decision.confidence.toFixed(2)}/100`,
    });
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
        candidatePlan: buildTradePlan(
          this.lastChain,
          d.decision.direction,
          d.decision.selectedStrike,
          d.market.atr,
          this.config,
        ),
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
    this.state = { ...initialEngineState(), ivHistory: this.state.ivHistory };
    await this.store.save(this.state, this.config);
  }

  backtest(): BacktestResult {
    return runBacktest(this.candles, this.config);
  }

  marketOpen() {
    return this.source.alwaysOpen || isWithinMarketHours(this.clock());
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
    const { ivHistory, ...rest } = this.state;
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
    };
  }
}
