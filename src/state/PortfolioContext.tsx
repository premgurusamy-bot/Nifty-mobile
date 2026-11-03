import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  cancelOrder as cancelOrderFn,
  initialPortfolio,
  matchOpenOrders,
  placeOrder as placeOrderFn,
  summarize,
  type Order,
  type OrderRequest,
  type PortfolioState,
  type PortfolioSummary,
} from '../lib/portfolio';
import { useMarket } from './MarketContext';

const STORAGE_KEY = 'nifty-paper-portfolio/v1';

interface PortfolioValue {
  state: PortfolioState;
  summary: PortfolioSummary;
  /** Places an order and returns the resulting order record. */
  placeOrder: (req: OrderRequest) => Order;
  cancelOrder: (orderId: string) => void;
  reset: () => void;
}

const PortfolioContext = createContext<PortfolioValue | null>(null);

let seq = 0;
const newOrderId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function PortfolioProvider({ children }: { children: ReactNode }) {
  const { getPrice, now } = useMarket();
  const [state, setState] = useState<PortfolioState>(initialPortfolio);
  const [hydrated, setHydrated] = useState(false);
  // Synchronous mirror so placeOrder can return the created order immediately.
  const stateRef = useRef(state);
  const commit = useCallback((next: PortfolioState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        // Don't clobber orders placed in the brief window before storage loaded.
        if (raw && stateRef.current.orders.length === 0) commit({ ...initialPortfolio(), ...JSON.parse(raw) });
      })
      .catch(() => {})
      .finally(() => setHydrated(true));
  }, [commit]);

  useEffect(() => {
    if (hydrated) AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state)).catch(() => {});
  }, [state, hydrated]);

  // Match resting limit orders on every market tick.
  useEffect(() => {
    const cur = stateRef.current;
    if (!cur.orders.some((o) => o.status === 'OPEN')) return;
    const next = matchOpenOrders(cur, getPrice, now);
    if (next !== cur) commit(next);
  }, [getPrice, now, commit]);

  const placeOrder = useCallback(
    (req: OrderRequest) => {
      const id = newOrderId();
      const next = placeOrderFn(stateRef.current, req, getPrice, Date.now(), id);
      commit(next);
      return next.orders.find((o) => o.id === id)!;
    },
    [getPrice, commit],
  );

  const cancelOrder = useCallback(
    (orderId: string) => commit(cancelOrderFn(stateRef.current, orderId, Date.now())),
    [commit],
  );
  const reset = useCallback(() => commit(initialPortfolio()), [commit]);

  const summary = useMemo(() => summarize(state, getPrice), [state, getPrice]);

  const value = useMemo(
    () => ({ state, summary, placeOrder, cancelOrder, reset }),
    [state, summary, placeOrder, cancelOrder, reset],
  );
  return <PortfolioContext.Provider value={value}>{children}</PortfolioContext.Provider>;
}

export function usePortfolio() {
  const ctx = useContext(PortfolioContext);
  if (!ctx) throw new Error('usePortfolio must be used inside PortfolioProvider');
  return ctx;
}
