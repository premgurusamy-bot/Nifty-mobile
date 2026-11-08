/// <reference types="node" />
/**
 * Minimal DhanHQ v2 REST client (https://api.dhan.co/v2).
 * Endpoints and payloads mirror Dhan's official Python SDK (dhanhq 2.3.0).
 */

export class DhanError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Serialises calls so consecutive requests are at least `minGapMs` apart (Dhan per-API rate limits). */
export class Throttle {
  private chain: Promise<unknown> = Promise.resolve();
  private last = 0;
  private minGapMs: number;
  constructor(minGapMs: number) {
    this.minGapMs = minGapMs;
  }
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      const wait = this.last + this.minGapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      return fn();
    });
    this.chain = next.catch(() => {});
    return next;
  }
}

export interface DhanOptions {
  clientId: string;
  accessToken: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export type Securities = Record<string, number[]>;

export const DHAN_API_URL = 'https://api.dhan.co/v2';
export const DHAN_AUTH_URL = 'https://auth.dhan.co';

/**
 * Log in with Dhan client ID + PIN + TOTP (the 6-digit code from an authenticator app) and get a
 * 24-hour access token. Same call as Dhan's own SDK (DhanLogin.generate_token):
 * POST https://auth.dhan.co/app/generateAccessToken?dhanClientId=…&pin=…&totp=…
 * TOTP must be enabled on the Dhan account (web.dhan.co → DhanHQ Trading APIs → Setup TOTP); the app
 * makes the code itself from the saved TOTP key (src/lib/totp.ts), so you only type the PIN.
 */
export async function dhanPinLogin(o: {
  clientId: string;
  pin: string;
  totp: string;
  authUrl?: string;
}): Promise<{ accessToken: string; expiry: string | null }> {
  const clientId = o.clientId.trim();
  const pin = o.pin.trim();
  const totp = o.totp.replace(/\s/g, '');
  if (!/^\d{5,}$/.test(clientId)) throw new Error('Dhan client ID is the number shown on your Dhan profile.');
  if (!/^\d{6}$/.test(pin)) throw new Error('Enter your 6-digit Dhan PIN.');
  if (!/^\d{6}$/.test(totp)) throw new Error('Enter the current 6-digit TOTP code from your authenticator app.');
  const q = new URLSearchParams({ dhanClientId: clientId, pin, totp });
  let res: Response;
  try {
    res = await fetch(`${o.authUrl || DHAN_AUTH_URL}/app/generateAccessToken?${q}`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
  } catch (e) {
    throw new Error(`Cannot reach Dhan login: ${(e as Error).message}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let j: any = null;
  try {
    j = await res.json();
  } catch {
    /* non-JSON error page */
  }
  const token = j?.accessToken ?? j?.access_token ?? j?.data?.accessToken;
  if (!res.ok || !token) {
    const why = j?.message ?? j?.errorMessage ?? j?.remarks ?? j?.error ?? `HTTP ${res.status}`;
    throw new Error(`Dhan login failed: ${typeof why === 'string' ? why : JSON.stringify(why)}`);
  }
  return { accessToken: String(token), expiry: j?.expiryTime ?? j?.data?.expiryTime ?? null };
}

export class DhanClient {
  private opts: Required<DhanOptions>;
  // Dhan limits: quote APIs 1 req/s, option chain 1 req/3s, data APIs a few per second.
  private quoteThrottle = new Throttle(1050);
  private chainThrottle = new Throttle(3100);
  private dataThrottle = new Throttle(250);
  private tradeThrottle = new Throttle(100);

  constructor(opts: DhanOptions) {
    // An explicit `undefined` (no test URL configured) must not wipe the defaults.
    this.opts = {
      ...opts,
      baseUrl: opts.baseUrl || DHAN_API_URL,
      timeoutMs: opts.timeoutMs ?? 15000,
    };
  }

  get clientId() {
    return this.opts.clientId;
  }

  /** Swap in a renewed access token (used by the token keeper). */
  setAccessToken(token: string) {
    this.opts.accessToken = token;
  }

  private async request<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.opts.baseUrl + path, {
        method,
        headers: {
          'access-token': this.opts.accessToken,
          'client-id': this.opts.clientId,
          // The SDK's profile / RenewToken calls identify the client with this header.
          dhanClientId: this.opts.clientId,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body ? JSON.stringify({ ...body, dhanClientId: this.opts.clientId }) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new DhanError(`Cannot reach Dhan: ${(e as Error).message}`, 502);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok) {
      const code = json?.errorCode ?? json?.data?.errorCode;
      const msg = json?.errorMessage ?? json?.data?.errorMessage ?? json?.remarks ?? `HTTP ${res.status}`;
      // DH-901: invalid/expired token. Dhan access tokens are short-lived.
      const hint =
        code === 'DH-901' ? ' — your Dhan access token is invalid or expired; generate a new one at web.dhan.co' : '';
      throw new DhanError(`${msg}${hint}`, res.status, code);
    }
    return json as T;
  }

  // ---- Market data -------------------------------------------------------
  quote(securities: Securities) {
    return this.quoteThrottle.run(() => this.request<any>('POST', '/marketfeed/quote', securities));
  }

  intraday(p: {
    securityId: string;
    exchangeSegment: string;
    instrument: string;
    fromDate: string;
    toDate: string;
    interval?: number;
    /** Include open interest per candle (F&O / commodity contracts). */
    oi?: boolean;
  }) {
    return this.dataThrottle.run(() => this.request<any>('POST', '/charts/intraday', { interval: 1, oi: false, ...p }));
  }

  expiryList(underlyingScrip: number, underlyingSeg: string) {
    return this.chainThrottle.run(() =>
      this.request<any>('POST', '/optionchain/expirylist', {
        UnderlyingScrip: underlyingScrip,
        UnderlyingSeg: underlyingSeg,
      }),
    );
  }

  optionChain(underlyingScrip: number, underlyingSeg: string, expiry: string) {
    return this.chainThrottle.run(() =>
      this.request<any>('POST', '/optionchain', {
        UnderlyingScrip: underlyingScrip,
        UnderlyingSeg: underlyingSeg,
        Expiry: expiry,
      }),
    );
  }

  // ---- Account -----------------------------------------------------------
  fundLimit() {
    return this.dataThrottle.run(() => this.request<any>('GET', '/fundlimit'));
  }
  positions() {
    return this.dataThrottle.run(() => this.request<any[]>('GET', '/positions'));
  }
  holdings() {
    return this.dataThrottle.run(() => this.request<any[]>('GET', '/holdings'));
  }
  /** Token validity and account setup (GET /v2/profile). */
  profile() {
    return this.request<any>('GET', '/profile');
  }

  /** Extends the current access token (GET /v2/RenewToken). Returns the response as-is. */
  renewToken() {
    return this.request<any>('GET', '/RenewToken');
  }

  // ---- Orders ------------------------------------------------------------
  orders() {
    return this.tradeThrottle.run(() => this.request<any[]>('GET', '/orders'));
  }
  order(orderId: string) {
    return this.tradeThrottle.run(() => this.request<any>('GET', `/orders/${encodeURIComponent(orderId)}`));
  }
  placeOrder(p: {
    securityId: string;
    exchangeSegment: string;
    transactionType: 'BUY' | 'SELL';
    quantity: number;
    orderType: 'MARKET' | 'LIMIT' | 'STOP_LOSS';
    productType: string;
    price: number;
    /** Required for STOP_LOSS (trigger), 0 otherwise. */
    triggerPrice?: number;
    correlationId?: string;
  }) {
    return this.tradeThrottle.run(() =>
      this.request<{ orderId: string; orderStatus: string }>('POST', '/orders', {
        validity: 'DAY',
        disclosedQuantity: 0,
        afterMarketOrder: false,
        ...p,
        triggerPrice: p.triggerPrice ?? 0,
      }),
    );
  }
  // ---- Instrument list (CSV) -------------------------------------------------
  /** Segment-wise instrument list, e.g. MCX_COMM (GET /v2/instrument/{segment}); raw CSV text. */
  async instrumentCsv(segment: string): Promise<string> {
    return this.dataThrottle.run(async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60_000);
      try {
        const res = await fetch(`${this.opts.baseUrl}/instrument/${encodeURIComponent(segment)}`, {
          headers: { 'access-token': this.opts.accessToken, 'client-id': this.opts.clientId, Accept: 'text/csv' },
          signal: ctrl.signal,
        });
        if (!res.ok) throw new DhanError(`Instrument list HTTP ${res.status}`, res.status);
        return await res.text();
      } finally {
        clearTimeout(timer);
      }
    });
  }

  // ---- Static IP (order APIs are only accepted from a whitelisted IP) ----------
  getIP() {
    return this.request<any>('GET', '/ip/getIP');
  }
  setIP(ip: string, ipFlag: 'PRIMARY' | 'SECONDARY' = 'PRIMARY') {
    return this.request<any>('POST', '/ip/setIP', { ip, ipFlag });
  }
  modifyIP(ip: string, ipFlag: 'PRIMARY' | 'SECONDARY' = 'PRIMARY') {
    return this.request<any>('PUT', '/ip/modifyIP', { ip, ipFlag });
  }

  cancelOrder(orderId: string) {
    return this.tradeThrottle.run(() => this.request<any>('DELETE', `/orders/${encodeURIComponent(orderId)}`));
  }
}
