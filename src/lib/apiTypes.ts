/**
 * Contract between the mobile app and the Dhan bridge server (server/).
 * Pure types only — imported by both sides.
 */
import type { ChainRow } from './optionChain.ts';
import type { Order, OrderRequest } from './portfolio.ts';
import type { Quote } from './simulator.ts';

export type Product = 'INTRADAY' | 'DELIVERY';

export interface StatusResponse {
  ok: boolean;
  /** True only when the server was started with LIVE_ORDERS=true. */
  liveOrders: boolean;
  clientId: string;
  lotSize: number;
  scripMaster: boolean;
  error?: string;
  /** Dhan access token check (GET /v2/profile), when the server runs a token keeper. */
  token?: { ok: boolean; validUntil: number | null; lastRenewal: number | null; message: string };
}

export interface QuotesResponse {
  quotes: Quote[];
}

export interface IntradayResponse {
  /** 1-minute closes for the latest trading session, oldest first. */
  points: number[];
}

export interface ExpiriesResponse {
  expiries: string[];
}

export interface OptionChainResponse {
  spot: number;
  rows: ChainRow[];
}

export interface PositionRow {
  key: string;
  instrumentId: string;
  /** Net quantity; negative means short. */
  qty: number;
  avgPrice: number;
  /** e.g. "INTRADAY", "CNC", "MARGIN", "HOLDING". */
  tag?: string;
  realized?: number;
  unrealized?: number;
}

export interface PortfolioResponse {
  cash: number;
  realizedPnl: number;
  rows: PositionRow[];
}

export interface OrdersResponse {
  orders: Order[];
}

export interface PlaceOrderBody extends OrderRequest {
  product: Product;
}

export interface PlaceOrderResponse {
  order: Order;
}

export interface ErrorResponse {
  error: string;
  code?: string;
}
