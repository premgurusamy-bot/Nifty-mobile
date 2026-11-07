/**
 * Multi-index cycle: runs the normal engine once per watched index, each with its own setup,
 * hold, IV history and calibration, against ONE shared account (trades today, P&L, journal,
 * the open position, day plan, events). Rules:
 *  - one trade at a time: the index in a trade manages it; the others keep watching, entries blocked;
 *  - with no trade open, if several indexes would enter in the same cycle, the highest score wins;
 *  - all daily limits and the day plan count across indexes (they live in the shared account).
 */
import { resetIfNewDay, runCycle, type RefreshInput } from './decision.ts';
import {
  SYMBOL_STATE_KEYS,
  type Candle,
  type ChainSnapshot,
  type Dashboard,
  type EngineConfig,
  type EngineEvent,
  type EngineState,
  type SymbolState,
} from './types.ts';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

export function pickSymbolState(s: Partial<EngineState>): SymbolState {
  const out = {} as Record<string, unknown>;
  for (const k of SYMBOL_STATE_KEYS) out[k] = s[k];
  out.ivHistory = s.ivHistory ?? [];
  return out as SymbolState;
}

/** The shared account part of a state (everything that isn't per index). */
function sharedOf(s: EngineState): Partial<EngineState> {
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
});

export interface MultiCycleResult {
  /** Shared account after the cycle (per-index fields still those of the previous active index). */
  shared: EngineState;
  watch: Record<string, SymbolState>;
  dashboards: Record<string, Dashboard>;
  /** The index that entered (or asked to enter, LIVE automatic) this cycle, if any. */
  winner: string | null;
  /** Indexes that also qualified this cycle but lost to the higher score. */
  passedOver: string[];
  errors: Record<string, string>;
}

export function runMultiCycle(
  master: EngineState,
  watchIn: Record<string, SymbolState>,
  symbols: string[],
  cfgFor: (symbol: string) => EngineConfig,
  data: Record<string, { candles: Candle[]; chain: ChainSnapshot }>,
  now: number,
): MultiCycleResult {
  let m = clone(master);
  delete m.watch;
  const dayBefore = m.day;
  resetIfNewDay(m, now);
  const watch = clone(watchIn);
  for (const sym of symbols) watch[sym] ??= blankSymbolState();
  // A new trading day clears every index's armed setup, not only the active one.
  if (m.day !== dayBefore) for (const sym of Object.keys(watch)) watch[sym] = { ...watch[sym], pending: null, liveAutoRequest: null };
  const dashboards: Record<string, Dashboard> = {};
  const errors: Record<string, string> = {};
  const fresh: EngineEvent[] = [];
  const input = (sym: string): RefreshInput => ({ ...data[sym], now });
  const compose = (sym: string, extra: Partial<EngineState> = {}): EngineState => ({ ...m, ...watch[sym], ...extra });

  // 1) The index in a trade manages its position with its own prices.
  const posSym = m.position ? (m.position.symbol ?? symbols[0]) : null;
  if (posSym && data[posSym]) {
    try {
      const r = runCycle(compose(posSym), cfgFor(posSym), input(posSym));
      m = { ...m, ...sharedOf(r.state) } as EngineState;
      watch[posSym] = pickSymbolState(r.state);
      dashboards[posSym] = r.dashboard;
    } catch (e) {
      errors[posSym] = (e as Error).message;
    }
  }

  // 2) The others: watch only while a trade is open; otherwise collect who would enter.
  const candidates: { sym: string; state: EngineState; dash: Dashboard }[] = [];
  for (const sym of symbols) {
    if (sym === posSym || !data[sym]) continue;
    const inTrade = !!m.position;
    const cfg = inTrade
      ? { ...cfgFor(sym), watchOnly: `In a ${m.position!.symbol ?? posSym} trade — watching only` }
      : cfgFor(sym);
    try {
      // Position hidden (it belongs to another index) and events collected separately.
      const r = runCycle(compose(sym, { position: null, events: [] }), cfg, input(sym));
      const opened = !inTrade && (!!r.state.position || !!r.state.liveAutoRequest);
      if (opened) candidates.push({ sym, state: r.state, dash: r.dashboard });
      else {
        watch[sym] = pickSymbolState(r.state);
        dashboards[sym] = r.dashboard;
        fresh.push(...r.state.events);
      }
    } catch (e) {
      errors[sym] = (e as Error).message;
    }
  }

  // 3) Highest score wins; the rest are told why they were passed over (their setup stays armed).
  let winner: string | null = null;
  const passedOver: string[] = [];
  if (candidates.length) {
    candidates.sort((a, b) => b.dash.decision.confidence - a.dash.decision.confidence);
    const best = candidates[0];
    winner = best.sym;
    const { events: wEvents, ...wShared } = sharedOf(best.state);
    m = { ...m, ...wShared } as EngineState;
    fresh.push(...(wEvents ?? []));
    watch[best.sym] = pickSymbolState(best.state);
    dashboards[best.sym] = best.dash;
    for (const c of candidates.slice(1)) {
      passedOver.push(c.sym);
      dashboards[c.sym] = {
        ...c.dash,
        decision: {
          ...c.dash.decision,
          decisionText: `SIGNAL CONFIRMED - ${best.sym} taken instead (higher score ${best.dash.decision.confidence.toFixed(1)})`,
        },
      };
    }
  }
  if (fresh.length) m.events = [...fresh, ...m.events].slice(0, 100);
  return { shared: m, watch, dashboards, winner, passedOver, errors };
}
