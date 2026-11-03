/**
 * RefreshAll orchestration (modMain), shared by the server (live Dhan data)
 * and the app's demo mode (simulated data). Data fetching and persistence
 * are injected so this file stays platform-neutral.
 */
import { runBacktest, type BacktestResult } from './backtest.ts';
import { isWithinMarketHours, runCycle } from './decision.ts';
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
      const { state, dashboard } = runCycle(this.state, this.config, { ...data, now });
      this.state = state;
      this.dashboard = dashboard;
      this.candles = data.candles;
      this.lastRefresh = now;
      this.status = 'Ready';
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
