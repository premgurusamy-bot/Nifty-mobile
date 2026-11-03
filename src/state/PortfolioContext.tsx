import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Api } from '../api/client';
import type { PositionRow, Product } from '../lib/apiTypes';
import {
  cancelOrder as cancelOrderFn,
  initialPortfolio,
  matchOpenOrders,
  placeOrder as placeOrderFn,
  type Order,
  type OrderRequest,
  type PortfolioState,
} from '../lib/portfolio';
import { useMarket, useWatch } from './MarketContext';
import { useSettings } from './SettingsContext';

const STORAGE_KEY = 'nifty-paper-portfolio/v1';

export type ExecutionMode = 'PAPER' | 'LIVE';

export interface Summary {
  invested: number;
  currentValue: number;
  unrealizedPnl: number;
  equity: number;
}

interface PortfolioValue {
  mode: ExecutionMode;
  cash: number;
  realizedPnl: number;
  charges: number;
  rows: PositionRow[];
  orders: Order[];
  summary: Summary;
  error: string | null;
  /** Net position for one instrument across product types. */
  positionFor: (id: string) => { qty: number; avgPrice: number } | null;
  placeOrder: (req: OrderRequest & { product?: Product }) => Promise<Order>;
  cancelOrder: (orderId: string) => Promise<void>;
  /** Paper only. */
  reset: () => void;
  refresh: () => void;
}

const PortfolioContext = createContext<PortfolioValue | null>(null);

let seq = 0;
const newOrderId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

function summarizeRows(rows: PositionRow[], cash: number, getPrice: (id: string) => number | null): Summary {
  let invested = 0;
  let currentValue = 0;
  let unrealizedPnl = 0;
  for (const r of rows) {
    const ltp = getPrice(r.instrumentId);
    invested += r.avgPrice * r.qty;
    currentValue += (ltp ?? r.avgPrice) * r.qty;
    unrealizedPnl += ltp != null ? (ltp - r.avgPrice) * r.qty : (r.unrealized ?? 0);
  }
  return { invested, currentValue, unrealizedPnl, equity: cash + currentValue };
}

function positionFrom(rows: PositionRow[], id: string) {
  const mine = rows.filter((r) => r.instrumentId === id);
  if (!mine.length) return null;
  const qty = mine.reduce((a, r) => a + r.qty, 0);
  const cost = mine.reduce((a, r) => a + r.qty * r.avgPrice, 0);
  return qty ? { qty, avgPrice: cost / qty } : null;
}

// ---------------------------------------------------------------- paper (simulated fills)

function usePaperPortfolio(): PortfolioValue {
  const { getPrice, now } = useMarket();
  const [state, setState] = useState<PortfolioState>(initialPortfolio);
  const [hydrated, setHydrated] = useState(false);
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

  // Live prices for positions and resting orders (no-op on the simulator).
  useWatch([
    ...Object.keys(state.positions),
    ...state.orders.filter((o) => o.status === 'OPEN').map((o) => o.instrumentId),
  ]);

  useEffect(() => {
    const cur = stateRef.current;
    if (!cur.orders.some((o) => o.status === 'OPEN')) return;
    const next = matchOpenOrders(cur, getPrice, now);
    if (next !== cur) commit(next);
  }, [getPrice, now, commit]);

  const rows = useMemo<PositionRow[]>(
    () =>
      Object.entries(state.positions).map(([id, p]) => ({
        key: id,
        instrumentId: id,
        qty: p.qty,
        avgPrice: p.avgPrice,
      })),
    [state.positions],
  );

  const placeOrder = useCallback(
    async (req: OrderRequest) => {
      const id = newOrderId();
      const next = placeOrderFn(stateRef.current, req, getPrice, Date.now(), id);
      commit(next);
      return next.orders.find((o) => o.id === id)!;
    },
    [getPrice, commit],
  );
  const cancelOrder = useCallback(
    async (orderId: string) => commit(cancelOrderFn(stateRef.current, orderId, Date.now())),
    [commit],
  );
  const reset = useCallback(() => commit(initialPortfolio()), [commit]);

  const value = useMemo<PortfolioValue>(
    () => ({
      mode: 'PAPER',
      cash: state.cash,
      realizedPnl: state.realizedPnl,
      charges: state.charges,
      rows,
      orders: state.orders,
      summary: summarizeRows(rows, state.cash, getPrice),
      error: null,
      positionFor: (id) => state.positions[id] ?? null,
      placeOrder,
      cancelOrder,
      reset,
      refresh: () => {},
    }),
    [state, rows, getPrice, placeOrder, cancelOrder, reset],
  );
  return value;
}

// ---------------------------------------------------------------- live (Dhan account)

const LIVE_POLL_MS = 4000;

function useLivePortfolio(api: Api | null): PortfolioValue {
  const { getPrice } = useMarket();
  const [cash, setCash] = useState(0);
  const [realized, setRealized] = useState(0);
  const [rows, setRows] = useState<PositionRow[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useWatch([
    ...rows.map((r) => r.instrumentId),
    ...orders.filter((o) => o.status === 'OPEN').map((o) => o.instrumentId),
  ]);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    const pull = async () => {
      try {
        const [p, o] = await Promise.all([api.portfolio(), api.orders()]);
        if (!alive) return;
        setCash(p.cash);
        setRealized(p.realizedPnl);
        setRows(p.rows);
        setOrders(o.orders);
        setError(null);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    pull();
    const t = setInterval(pull, LIVE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [api, tick]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  const placeOrder = useCallback(
    async (req: OrderRequest & { product?: Product }) => {
      if (!api) throw new Error('Not connected');
      const { order } = await api.placeOrder({ ...req, product: req.product ?? 'INTRADAY' });
      refresh();
      return order;
    },
    [api, refresh],
  );
  const cancelOrder = useCallback(
    async (id: string) => {
      if (!api) throw new Error('Not connected');
      await api.cancelOrder(id);
      refresh();
    },
    [api, refresh],
  );

  const value = useMemo<PortfolioValue>(
    () => ({
      mode: 'LIVE',
      cash,
      realizedPnl: realized,
      charges: 0,
      rows,
      orders,
      summary: summarizeRows(rows, cash, getPrice),
      error,
      positionFor: (id) => positionFrom(rows, id),
      placeOrder,
      cancelOrder,
      reset: () => {},
      refresh,
    }),
    [cash, realized, rows, orders, getPrice, error, placeOrder, cancelOrder, refresh],
  );
  return value;
}

export function PortfolioProvider({ children }: { children: ReactNode }) {
  const { api, server } = useSettings();
  const liveOn = !!api && !!server?.liveOrders;
  // Both stay mounted (no screen remounts on mode switch); the live one only polls when enabled.
  const paper = usePaperPortfolio();
  const live = useLivePortfolio(liveOn ? api : null);
  return <PortfolioContext.Provider value={liveOn ? live : paper}>{children}</PortfolioContext.Provider>;
}

export function usePortfolio() {
  const ctx = useContext(PortfolioContext);
  if (!ctx) throw new Error('usePortfolio must be used inside PortfolioProvider');
  return ctx;
}
