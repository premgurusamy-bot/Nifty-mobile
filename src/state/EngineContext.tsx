import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BacktestResult } from '../lib/engine/backtest';
import { EngineRunner, type EngineExport, type EngineSnapshot, type EngineStore } from '../lib/engine/runner';
import { SimEngineSource } from '../lib/engine/simSource';
import type { PreflightResult } from '../../server/preflight.ts';
import { isLocalApi } from '../api/localApi';
import type { EngineConfig, TradeMode } from '../lib/engine/types';
import { useSettings, type DataMode } from './SettingsContext';

/**
 * The option-buying engine (ported from the Excel workbook).
 * DHAN mode: the server runs it on live data; the app polls and sends commands.
 * DEMO mode: the same engine runs on the phone against an accelerated simulation.
 */
interface EngineValue {
  mode: DataMode;
  snap: EngineSnapshot | null;
  busy: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  updateConfig: (patch: Partial<EngineConfig>) => Promise<void>;
  backtest: () => Promise<BacktestResult>;
  resetJournal: () => Promise<void>;
  /** Journal, decision log, events and settings for export. */
  exportData: () => Promise<EngineExport>;
  /** True when connected to Dhan from this phone (LIVE trading possible). */
  phone: boolean;
  /** Manual ENTER / EXIT of the engine's trade (real Dhan orders in LIVE mode). */
  /** `limit` = buy price per unit (blank = market). */
  enter: (limit?: number) => Promise<void>;
  cancelEntry: () => Promise<void>;
  exit: () => Promise<void>;
  /** Returns the pre-flight result when switching to LIVE (null otherwise); LIVE only applies if it passed. */
  setTradeMode: (mode: TradeMode) => Promise<PreflightResult | null>;
  preflight: () => Promise<PreflightResult>;
}

const Ctx = createContext<EngineValue | null>(null);
const DEMO_KEY = 'nifty/engine-demo/v1';
const POLL_MS = 5000;
const FAST_POLL_MS = 1500;
const DEMO_TICK_MS = 3000;

const demoStore: EngineStore = {
  load: async () => {
    const raw = await AsyncStorage.getItem(DEMO_KEY);
    return raw ? JSON.parse(raw) : null;
  },
  save: async (state, config) => {
    await AsyncStorage.setItem(DEMO_KEY, JSON.stringify({ state, config }));
  },
};

export function EngineProvider({ children }: { children: ReactNode }) {
  const { api, mode, refreshStatus } = useSettings();
  const phoneApi = isLocalApi(api) ? api : null;
  const [snap, setSnap] = useState<EngineSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const demo = useRef<EngineRunner | null>(null);
  // Don't show the demo's snapshot as if it were live (or vice versa) after switching.
  const [sourceKey, setSourceKey] = useState<unknown>(api);
  if (sourceKey !== api) {
    setSourceKey(api);
    setSnap(null);
  }

  // ---- DEMO: local runner ----
  useEffect(() => {
    if (mode !== 'DEMO') return;
    let cancelled = false;
    const runner = new EngineRunner(new SimEngineSource(Date.now() % 100000), demoStore);
    demo.current = runner;
    runner.init().then(async () => {
      if (cancelled) return;
      await runner.refresh();
      if (!cancelled) setSnap(runner.snapshot(true));
    });
    return () => {
      cancelled = true;
      demo.current = null;
    };
  }, [mode]);

  const autoDemo = mode === 'DEMO' && !!snap?.config.autoRefresh;
  useEffect(() => {
    if (!autoDemo) return;
    const t = setInterval(async () => {
      const r = demo.current;
      if (!r) return;
      await r.refresh();
      setSnap(r.snapshot(true));
    }, DEMO_TICK_MS);
    return () => clearInterval(t);
  }, [autoDemo]);

  // ---- DHAN: poll the server ----
  useEffect(() => {
    if (mode !== 'DHAN' || !api) return;
    let alive = true;
    let t: ReturnType<typeof setTimeout> | null = null;
    // While a trade is open on this phone, pull often so the running P&L ticks.
    let fast = false;
    let pollMs = POLL_MS;
    const pull = () =>
      api
        .engine()
        .then((s) => {
          if (!alive) return;
          fast = !!s.state.position && isLocalApi(api);
          pollMs = isLocalApi(api) && s.config.autoRefresh
            ? Math.min(POLL_MS, Math.max(FAST_POLL_MS, (s.config.refreshSeconds * 1000) / 2))
            : POLL_MS;
          setSnap(s);
          setError(null);
        })
        .catch((e) => alive && setError(e.message))
        .finally(() => {
          // Follow the engine: no slower than its refresh interval (3 s → 1.5 s pulls), at most 5 s.
          if (alive) t = setTimeout(pull, fast ? FAST_POLL_MS : pollMs);
        });
    pull();
    return () => {
      alive = false;
      if (t) clearTimeout(t);
    };
  }, [mode, api]);

  const run = useCallback(async (fn: () => Promise<EngineSnapshot | void>) => {
    setBusy(true);
    try {
      const s = await fn();
      if (s) setSnap(s);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
    }
  }, []);

  const refresh = useCallback(
    () =>
      run(async () => {
        if (api) return api.engineRefresh();
        const r = demo.current!;
        await r.refresh();
        return r.snapshot(true);
      }),
    [api, run],
  );

  const updateConfig = useCallback(
    (patch: Partial<EngineConfig>) =>
      run(async () => {
        if (api) return api.engineConfig(patch);
        const r = demo.current!;
        await r.updateConfig(patch);
        r.stop(); // the demo ticks via this context, not the runner's own timer
        return r.snapshot(true);
      }),
    [api, run],
  );

  const backtest = useCallback(async () => (api ? api.engineBacktest() : demo.current!.backtest()), [api]);

  const exportData = useCallback(
    async () => (api ? api.engineExport() : demo.current!.exportData()),
    [api],
  );

  const resetJournal = useCallback(
    () =>
      run(async () => {
        if (api) return api.engineResetJournal();
        const r = demo.current!;
        await r.resetJournal();
        return r.snapshot(true);
      }),
    [api, run],
  );

  const enter = useCallback(
    (limit?: number) =>
      run(async () => {
        if (phoneApi) return phoneApi.engineEnter(limit);
        if (api) throw new Error('Manual entry is available with the phone connection.');
        const r = demo.current!;
        await r.placeEntry(limit);
        return r.snapshot(true);
      }),
    [api, phoneApi, run],
  );

  const cancelEntry = useCallback(
    () =>
      run(async () => {
        if (phoneApi) return phoneApi.engineCancelEntry();
        if (api) throw new Error('Not available with the server connection.');
        const r = demo.current!;
        await r.cancelPendingEntry();
        return r.snapshot(true);
      }),
    [api, phoneApi, run],
  );

  const exit = useCallback(
    () =>
      run(async () => {
        if (phoneApi) return phoneApi.engineExit();
        if (api) throw new Error('Manual exit is available with the phone connection.');
        const r = demo.current!;
        await r.manualExit();
        return r.snapshot(true);
      }),
    [api, phoneApi, run],
  );

  const setTradeMode = useCallback(
    async (m: TradeMode) => {
      if (!phoneApi) throw new Error('Connect your Dhan account in Settings to trade LIVE.');
      let pf: PreflightResult | null = null;
      await run(async () => {
        const r = await phoneApi.setTradeMode(m);
        pf = r.preflight;
        return r.snapshot;
      });
      await refreshStatus().catch(() => {});
      return pf;
    },
    [phoneApi, run, refreshStatus],
  );

  const preflight = useCallback(async () => {
    if (!phoneApi) throw new Error('Connect your Dhan account in Settings first.');
    return phoneApi.preflight();
  }, [phoneApi]);

  const value = useMemo(
    () => ({
      mode,
      snap,
      busy,
      error,
      refresh,
      updateConfig,
      backtest,
      resetJournal,
      exportData,
      phone: !!phoneApi,
      enter,
      cancelEntry,
      exit,
      setTradeMode,
      preflight,
    }),
    [
      mode,
      snap,
      busy,
      error,
      refresh,
      updateConfig,
      backtest,
      resetJournal,
      exportData,
      phoneApi,
      enter,
      cancelEntry,
      exit,
      setTradeMode,
      preflight,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useEngine() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useEngine must be used inside EngineProvider');
  return c;
}
