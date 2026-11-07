/**
 * Multi-index cycle: runs the normal engine once per watched index, each with its own setup,
 * hold, IV history, calibration and open trade, against ONE shared account (trades today, P&L,
 * journal, day plan, events). Rules:
 *  - several indexes may be in a trade at once; each manages its own position with its own prices;
 *  - indexes that qualify in the same cycle all enter, the highest score first (it is trade 1 for
 *    the day plan); every gate (limits, day plan, cutoff) is checked again in that order;
 *  - SPLIT sizing: while N index trades are open, each new one gets 1/N of the normal lots;
 *  - all daily limits and the day plan count across indexes (they live in the shared account).
 */
import { resetIfNewDay, runCycle, type RefreshInput } from './decision.ts';
import type { SizingConfig } from './sizing.ts';
import {
  SYMBOL_STATE_KEYS,
  type Candle,
  type ChainSnapshot,
  type Dashboard,
  type EngineConfig,
  type EngineState,
  type SymbolState,
} from './types.ts';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

export function pickSymbolState(s: Partial<EngineState>): SymbolState {
  const out = {} as Record<string, unknown>;
  for (const k of SYMBOL_STATE_KEYS) out[k] = s[k];
  out.ivHistory = s.ivHistory ?? [];
  out.position = s.position ?? null;
  out.pendingEntry = s.pendingEntry ?? null;
  return out as SymbolState;
}

/** The shared account part of a state (everything that isn't per index). */
export function sharedOf(s: EngineState): Partial<EngineState> {
  const out: Record<string, unknown> = { ...s };
  for (const k of SYMBOL_STATE_KEYS) delete out[k];
  delete out.watch;
  return out as Partial<EngineState>;
}

export const blankSymbolState = (ivHistory: number[] = []): SymbolState => ({
  pending: null,
  ivHistory,
  ivLastAt: undefined,
  lastSignalKey: undefined,
  lastDecisionText: '',
  blockedReason: '',
  liveAutoRequest: null,
  lastFiredKey: '',
  position: null,
  pendingEntry: null,
});

/** A saved per-index entry from an older version (no position / pendingEntry keys) made complete. */
export const normalizeSymbolState = (w: Partial<SymbolState> | undefined): SymbolState => ({
  ...blankSymbolState(),
  ...(w ?? {}),
  ivHistory: w?.ivHistory ?? [],
  position: w?.position ?? null,
  pendingEntry: w?.pendingEntry ?? null,
});

/** An index holding a trade or a pending entry order (it manages that, it can't open another). */
export const isBusy = (w: Partial<SymbolState> | undefined) => !!(w?.position || w?.pendingEntry);

/** SPLIT sizing: each of `trades` simultaneous index trades gets this share of the normal lots. */
export function splitFactor(cfg: Pick<EngineConfig, 'multiSize'>, trades: number): number {
  return cfg.multiSize === 'FULL' || trades <= 1 ? 1 : 1 / trades;
}

export interface MultiCycleResult {
  /** Shared account after the cycle (per-index fields: use `watch`). */
  shared: EngineState;
  watch: Record<string, SymbolState>;
  dashboards: Record<string, Dashboard>;
  /** Indexes that entered (or asked to enter, LIVE automatic) this cycle, highest score first. */
  entered: string[];
  /** The order the indexes ran in (trades first, then by score): live orders follow it. */
  order: string[];
  /** Split share of the normal size the entering indexes were sized with. */
  sizeFactor: number;
  errors: Record<string, string>;
}

export function runMultiCycle(
  master: EngineState,
  watchIn: Record<string, SymbolState>,
  symbols: string[],
  cfgFor: (symbol: string) => SizingConfig,
  data: Record<string, { candles: Candle[]; chain: ChainSnapshot }>,
  now: number,
): MultiCycleResult {
  let m = clone(master);
  delete m.watch;
  const dayBefore = m.day;
  resetIfNewDay(m, now);
  const watch: Record<string, SymbolState> = {};
  for (const [sym, w] of Object.entries(clone(watchIn ?? {}))) watch[sym] = normalizeSymbolState(w);
  for (const sym of symbols) watch[sym] ??= blankSymbolState();
  // A new trading day clears every index's armed setup and paper limit entry (live ones stay tracked).
  if (m.day !== dayBefore)
    for (const sym of Object.keys(watch)) {
      const w = watch[sym];
      watch[sym] = { ...w, pending: null, liveAutoRequest: null, pendingEntry: w.pendingEntry?.live ? w.pendingEntry : null };
    }
  const dashboards: Record<string, Dashboard> = {};
  const errors: Record<string, string> = {};
  const input = (sym: string): RefreshInput => ({ ...data[sym], now });
  const compose = (sym: string): EngineState => ({ ...m, ...watch[sym] });
  const run = (sym: string, cfg: SizingConfig) => {
    try {
      const r = runCycle(compose(sym), cfg, input(sym));
      m = { ...m, ...sharedOf(r.state) } as EngineState;
      watch[sym] = pickSymbolState(r.state);
      dashboards[sym] = r.dashboard;
      return r;
    } catch (e) {
      errors[sym] = (e as Error).message;
      return null;
    }
  };
  const live = symbols.filter((s) => data[s]);

  // 1) Indexes in a trade (or with an entry order out) manage it with their own prices.
  const holding = live.filter((s) => isBusy(watch[s]));
  for (const sym of holding) run(sym, cfgFor(sym));

  // 2) The rest: a dry run ranks them by score and counts who would enter now...
  const free = live.filter((s) => !holding.includes(s));
  const ranked = free.map((sym) => {
    try {
      const r = runCycle(clone(compose(sym)), cfgFor(sym), input(sym));
      return { sym, conf: r.dashboard.decision.confidence, opens: !!r.state.position || !!r.state.liveAutoRequest };
    } catch {
      return { sym, conf: -Infinity, opens: false };
    }
  });
  ranked.sort((a, b) => b.conf - a.conf);
  const openNow = Object.values(watch).filter((w) => w.position).length;
  const sizeFactor = splitFactor(cfgFor(live[0] ?? symbols[0]), openNow + ranked.filter((r) => r.opens).length);

  // ...then they run for real, highest score first: each one's entry is in the shared account
  // before the next one is checked (trade count, day plan, limits).
  const entered: string[] = [];
  for (const { sym } of ranked) {
    const r = run(sym, { ...cfgFor(sym), sizeFactor });
    if (r && (r.state.position || r.state.liveAutoRequest)) entered.push(sym);
  }
  return {
    shared: { ...m, ...blankSymbolState(m.ivHistory) } as EngineState,
    watch,
    dashboards,
    entered,
    order: [...holding, ...ranked.map((r) => r.sym)],
    sizeFactor,
    errors,
  };
}
