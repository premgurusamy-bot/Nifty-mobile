import { lotSize } from './instruments.ts';

/**
 * Paper-trading engine. Pure functions only — UI state lives in
 * src/state/PortfolioContext.tsx.
 *
 * Model: long-only. A SELL can only close (part of) an existing position.
 * Market orders fill at LTP; limit orders fill at LTP once it crosses the
 * limit. A flat brokerage fee is charged on every fill. Margin, taxes and
 * option expiry settlement are not modelled.
 */

export type Side = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT';
export type OrderStatus = 'OPEN' | 'FILLED' | 'CANCELLED' | 'REJECTED';

export interface Order {
  id: string;
  instrumentId: string;
  side: Side;
  /** Units (for options: lots × lot size). */
  qty: number;
  type: OrderType;
  limitPrice?: number;
  status: OrderStatus;
  fillPrice?: number;
  reason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Position {
  qty: number;
  avgPrice: number;
}

export interface PortfolioState {
  cash: number;
  positions: Record<string, Position>;
  orders: Order[];
  realizedPnl: number;
  charges: number;
}

export const STARTING_CASH = 1_000_000;
export const BROKERAGE_PER_ORDER = 20;

export const initialPortfolio = (): PortfolioState => ({
  cash: STARTING_CASH,
  positions: {},
  orders: [],
  realizedPnl: 0,
  charges: 0,
});

export interface OrderRequest {
  instrumentId: string;
  side: Side;
  qty: number;
  type: OrderType;
  limitPrice?: number;
}

export type PriceLookup = (instrumentId: string) => number | null;

/** Validation that doesn't depend on price. Returns an error message or null. */
export function validateRequest(req: OrderRequest): string | null {
  if (!Number.isInteger(req.qty) || req.qty <= 0) return 'Quantity must be a positive whole number';
  const lot = lotSize(req.instrumentId);
  if (req.qty % lot !== 0) return `Quantity must be a multiple of lot size ${lot}`;
  if (req.type === 'LIMIT' && !(req.limitPrice && req.limitPrice > 0)) return 'Enter a valid limit price';
  return null;
}

const isMarketable = (o: Order, ltp: number) =>
  o.type === 'MARKET' || (o.side === 'BUY' ? ltp <= o.limitPrice! : ltp >= o.limitPrice!);

/** Execute an order at `price`, returning the new state with the order FILLED or REJECTED. */
function execute(state: PortfolioState, order: Order, price: number, now: number): PortfolioState {
  const pos = state.positions[order.instrumentId] ?? { qty: 0, avgPrice: 0 };
  const value = price * order.qty;
  const reject = (reason: string) => replaceOrder(state, { ...order, status: 'REJECTED', reason, updatedAt: now });

  let positions = { ...state.positions };
  let cash = state.cash;
  let realized = state.realizedPnl;

  if (order.side === 'BUY') {
    if (value + BROKERAGE_PER_ORDER > cash) return reject('Insufficient funds');
    const qty = pos.qty + order.qty;
    positions[order.instrumentId] = { qty, avgPrice: (pos.avgPrice * pos.qty + value) / qty };
    cash -= value;
  } else {
    if (order.qty > pos.qty)
      return reject(pos.qty === 0 ? 'No open position to sell' : `Only ${pos.qty} available to sell`);
    realized += (price - pos.avgPrice) * order.qty;
    const qty = pos.qty - order.qty;
    if (qty === 0) delete positions[order.instrumentId];
    else positions[order.instrumentId] = { qty, avgPrice: pos.avgPrice };
    cash += value;
  }

  cash -= BROKERAGE_PER_ORDER;
  const next: PortfolioState = {
    ...state,
    cash,
    positions,
    realizedPnl: realized,
    charges: state.charges + BROKERAGE_PER_ORDER,
  };
  return replaceOrder(next, { ...order, status: 'FILLED', fillPrice: price, updatedAt: now });
}

function replaceOrder(state: PortfolioState, order: Order): PortfolioState {
  const exists = state.orders.some((o) => o.id === order.id);
  return {
    ...state,
    orders: exists ? state.orders.map((o) => (o.id === order.id ? order : o)) : [order, ...state.orders],
  };
}

export function placeOrder(
  state: PortfolioState,
  req: OrderRequest,
  getPrice: PriceLookup,
  now: number,
  id: string,
): PortfolioState {
  const order: Order = { ...req, id, status: 'OPEN', createdAt: now, updatedAt: now };
  if (req.type === 'MARKET') delete order.limitPrice;
  const err = validateRequest(req);
  if (err) return replaceOrder(state, { ...order, status: 'REJECTED', reason: err });
  const ltp = getPrice(req.instrumentId);
  if (ltp == null) return replaceOrder(state, { ...order, status: 'REJECTED', reason: 'No price available' });
  if (isMarketable(order, ltp)) return execute(state, order, ltp, now);
  return replaceOrder(state, order);
}

/** Try to fill any open limit orders against current prices. */
export function matchOpenOrders(state: PortfolioState, getPrice: PriceLookup, now: number): PortfolioState {
  let next = state;
  // Oldest first so earlier orders get priority on cash.
  const open = state.orders.filter((o) => o.status === 'OPEN').reverse();
  for (const o of open) {
    const ltp = getPrice(o.instrumentId);
    if (ltp != null && isMarketable(o, ltp)) next = execute(next, o, ltp, now);
  }
  return next;
}

export function cancelOrder(state: PortfolioState, orderId: string, now: number): PortfolioState {
  const o = state.orders.find((x) => x.id === orderId);
  if (!o || o.status !== 'OPEN') return state;
  return replaceOrder(state, { ...o, status: 'CANCELLED', updatedAt: now });
}

export interface PortfolioSummary {
  invested: number;
  currentValue: number;
  unrealizedPnl: number;
  equity: number;
}

export function summarize(state: PortfolioState, getPrice: PriceLookup): PortfolioSummary {
  let invested = 0;
  let currentValue = 0;
  for (const [id, p] of Object.entries(state.positions)) {
    invested += p.avgPrice * p.qty;
    currentValue += (getPrice(id) ?? p.avgPrice) * p.qty;
  }
  return { invested, currentValue, unrealizedPnl: currentValue - invested, equity: state.cash + currentValue };
}
