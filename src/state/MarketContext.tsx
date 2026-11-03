import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { kindOf, NIFTY_ID } from '../lib/instruments';
import { priceOption } from '../lib/optionChain';
import { createSim, mulberry32, stepSim, type Quote, type SimState } from '../lib/simulator';
import { marketStatus, type MarketStatus } from '../lib/time';

interface MarketValue {
  quotes: Record<string, Quote>;
  history: Record<string, number[]>;
  spot: number;
  now: number;
  status: MarketStatus;
  /** LTP for any tradeable instrument (equities and NIFTY options). */
  getPrice: (id: string) => number | null;
}

const MarketContext = createContext<MarketValue | null>(null);

const TICK_MS = 1000;

export function MarketProvider({ children }: { children: ReactNode }) {
  const [sim, setSim] = useState<SimState>(() => createSim());
  const [now, setNow] = useState(() => Date.now());
  const rand = useRef(mulberry32(sim.seed + 1));

  useEffect(() => {
    const t = setInterval(() => {
      setSim((s) => stepSim(s, rand.current));
      setNow(Date.now());
    }, TICK_MS);
    return () => clearInterval(t);
  }, []);

  const spot = sim.quotes[NIFTY_ID].ltp;

  const getPrice = useCallback(
    (id: string) => {
      if (kindOf(id) === 'OPTION') return priceOption(id, spot, now);
      return sim.quotes[id]?.ltp ?? null;
    },
    [sim, spot, now],
  );

  const value = useMemo<MarketValue>(
    () => ({ quotes: sim.quotes, history: sim.history, spot, now, status: marketStatus(now), getPrice }),
    [sim, spot, now, getPrice],
  );

  return <MarketContext.Provider value={value}>{children}</MarketContext.Provider>;
}

export function useMarket() {
  const ctx = useContext(MarketContext);
  if (!ctx) throw new Error('useMarket must be used inside MarketProvider');
  return ctx;
}
