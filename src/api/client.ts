import type {
  ExpiriesResponse,
  IntradayResponse,
  OptionChainResponse,
  OrdersResponse,
  PlaceOrderBody,
  PlaceOrderResponse,
  PortfolioResponse,
  QuotesResponse,
  StatusResponse,
} from '../lib/apiTypes';
import type { BacktestResult } from '../lib/engine/backtest';
import type { EngineSnapshot } from '../lib/engine/runner';
import type { EngineConfig } from '../lib/engine/types';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Typed client for the Nifty Trader bridge server (server/). */
export function createApi(baseUrl: string, apiKey: string, timeoutMs = 20000) {
  const root = baseUrl.replace(/\/+$/, '');
  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(root + path, {
        method,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new ApiError(ctrl.signal.aborted ? 'Server timed out' : `Cannot reach server (${(e as Error).message})`, 0);
    } finally {
      clearTimeout(timer);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(json.error ?? `HTTP ${res.status}`, res.status);
    return json as T;
  }
  const q = encodeURIComponent;
  return {
    status: () => req<StatusResponse>('GET', '/api/status'),
    quotes: (ids: string[]) => req<QuotesResponse>('GET', `/api/quotes?ids=${q(ids.join(','))}`),
    intraday: (id: string) => req<IntradayResponse>('GET', `/api/intraday?id=${q(id)}`),
    expiries: () => req<ExpiriesResponse>('GET', '/api/expiries'),
    optionChain: (expiry: string) => req<OptionChainResponse>('GET', `/api/optionchain?expiry=${q(expiry)}`),
    portfolio: () => req<PortfolioResponse>('GET', '/api/portfolio'),
    orders: () => req<OrdersResponse>('GET', '/api/orders'),
    placeOrder: (body: PlaceOrderBody) => req<PlaceOrderResponse>('POST', '/api/orders', body),
    cancelOrder: (id: string) => req<{ ok: true }>('DELETE', `/api/orders/${q(id)}`),
    engine: () => req<EngineSnapshot>('GET', '/api/engine'),
    engineRefresh: () => req<EngineSnapshot>('POST', '/api/engine/refresh'),
    engineConfig: (patch: Partial<EngineConfig>) => req<EngineSnapshot>('PUT', '/api/engine/config', patch),
    engineBacktest: () => req<BacktestResult>('GET', '/api/engine/backtest'),
    engineResetJournal: () => req<EngineSnapshot>('POST', '/api/engine/reset-journal'),
  };
}

export type Api = ReturnType<typeof createApi>;
