import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Api } from '../api/client';
import { EQUITIES, NIFTY_ID, equityId, kindOf } from '../lib/instruments';
import { priceOption } from '../lib/optionChain';
import { createSim, mulberry32, stepSim, type Quote, type SimState } from '../lib/simulator';
import { marketStatus, type MarketStatus } from '../lib/time';
import { useSettings } from './SettingsContext';

export type MarketSource = 'SIM' | 'DHAN';

interface MarketValue {
  source: MarketSource;
  quotes: Record<string, Quote>;
  history: Record<string, number[]>;
  spot: number;
  now: number;
  status: MarketStatus;
  error: string | null;
  /** LTP for any tradeable instrument (equities, NIFTY options, broker holdings). */
  getPrice: (id: string) => number | null;
  /** Ask for live quotes on extra instruments (positions, open orders, the order ticket). Returns an unsubscribe. */
  watch: (ids: string[]) => () => void;
  /** Feed option premiums from a fetched chain so they price immediately. */
  seedPrices: (prices: Record<string, number>) => void;
}

const MarketContext = createContext<MarketValue | null>(null);

const TICK_MS = 1000;
const LIVE_POLL_MS = 2000;
const BASE_IDS = [NIFTY_ID, ...EQUITIES.map((e) => equityId(e.symbol))];
const noop = () => () => {};

function useSimMarket(active: boolean): MarketValue {
  const [sim, setSim] = useState<SimState>(() => createSim());
  const [now, setNow] = useState(() => Date.now());
  const rand = useRef(mulberry32(sim.seed + 1));

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      setSim((s) => stepSim(s, rand.current));
      setNow(Date.now());
    }, TICK_MS);
    return () => clearInterval(t);
  }, [active]);

  const spot = sim.quotes[NIFTY_ID].ltp;
  const getPrice = useCallback(
    (id: string) => (kindOf(id) === 'OPTION' ? priceOption(id, spot, now) : (sim.quotes[id]?.ltp ?? null)),
    [sim, spot, now],
  );
  const value = useMemo<MarketValue>(
    () => ({
      source: 'SIM',
      quotes: sim.quotes,
      history: sim.history,
      spot,
      now,
      status: marketStatus(now),
      error: null,
      getPrice,
      watch: noop,
      seedPrices: () => {},
    }),
    [sim, spot, now, getPrice],
  );
  return value;
}

const placeholder = (id: string): Quote => ({ id, ltp: 0, open: 0, high: 0, low: 0, prevClose: 0 });

function useLiveMarket(api: Api | null): MarketValue {
  const [quotes, setQuotes] = useState<Record<string, Quote>>(() =>
    Object.fromEntries(BASE_IDS.map((id) => [id, placeholder(id)])),
  );
  const [history, setHistory] = useState<Record<string, number[]>>(() =>
    Object.fromEntries(BASE_IDS.map((id) => [id, []])),
  );
  const [seeded, setSeeded] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const watched = useRef(new Map<string, number>());
  const lastMinute = useRef(0);

  // Intraday 1-minute history for the chart/sparklines, fetched once per id.
  useEffect(() => {
    if (!api) return;
    let alive = true;
    (async () => {
      for (const id of BASE_IDS) {
        try {
          const { points } = await api.intraday(id);
          if (!alive) return;
          setHistory((h) => ({ ...h, [id]: points }));
        } catch {
          /* chart stays empty for this id */
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [api]);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    const pull = async () => {
      const ids = [...BASE_IDS, ...watched.current.keys()];
      try {
        const { quotes: list } = await api.quotes(ids);
        if (!alive) return;
        const t = Date.now();
        const minute = Math.floor(t / 60000);
        const newMinute = minute !== lastMinute.current;
        lastMinute.current = minute;
        setQuotes((q) => {
          const next = { ...q };
          for (const x of list) next[x.id] = x;
          return next;
        });
        // Keep the chart current: replace the last point, append when the minute rolls over.
        setHistory((h) => {
          const next = { ...h };
          for (const x of list) {
            if (!(x.id in next)) continue;
            const arr = next[x.id].slice();
            if (newMinute || !arr.length) arr.push(x.ltp);
            else arr[arr.length - 1] = x.ltp;
            next[x.id] = arr;
          }
          return next;
        });
        setNow(t);
        setError(null);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    pull();
    const timer = setInterval(pull, LIVE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api]);

  const watch = useCallback((ids: string[]) => {
    for (const id of ids) watched.current.set(id, (watched.current.get(id) ?? 0) + 1);
    return () => {
      for (const id of ids) {
        const n = (watched.current.get(id) ?? 1) - 1;
        if (n <= 0) watched.current.delete(id);
        else watched.current.set(id, n);
      }
    };
  }, []);

  const seedPrices = useCallback((p: Record<string, number>) => setSeeded((s) => ({ ...s, ...p })), []);

  const getPrice = useCallback(
    (id: string) => {
      const q = quotes[id];
      if (q && q.ltp > 0) return q.ltp;
      return seeded[id] ?? null;
    },
    [quotes, seeded],
  );

  const value = useMemo<MarketValue>(
    () => ({
      source: 'DHAN',
      quotes,
      history,
      spot: quotes[NIFTY_ID]?.ltp ?? 0,
      now,
      status: marketStatus(now),
      error,
      getPrice,
      watch,
      seedPrices,
    }),
    [quotes, history, now, error, getPrice, watch, seedPrices],
  );
  return value;
}

export function MarketProvider({ children }: { children: ReactNode }) {
  const { api } = useSettings();
  // Both hooks stay mounted so switching demo <-> live never remounts the screens below.
  const sim = useSimMarket(!api);
  const live = useLiveMarket(api);
  return <MarketContext.Provider value={api ? live : sim}>{children}</MarketContext.Provider>;
}

export function useMarket() {
  const ctx = useContext(MarketContext);
  if (!ctx) throw new Error('useMarket must be used inside MarketProvider');
  return ctx;
}

/** Subscribe to live quotes for `ids` while the calling component is mounted. */
export function useWatch(ids: string[]) {
  const { watch } = useMarket();
  const key = ids.join(',');
  useEffect(() => (key ? watch(key.split(',')) : undefined), [key, watch]);
}
