/**
 * Angel One SmartAPI (market data only, for now): login with client code + MPIN + TOTP,
 * 5-min candles, quotes (LTP / FULL with OI), option Greeks, and the contract search
 * used to find option tokens. Orders stay on Dhan.
 *
 * Routes and headers follow Angel's official SmartAPI client (smartapi-python):
 * base https://apiconnect.angelone.in, X-PrivateKey = your SmartAPI app's API key.
 * No Node-only imports: runs on the phone.
 */
import { Throttle } from './dhan.ts';

export const ANGEL_API_URL = 'https://apiconnect.angelone.in';

export class AngelError extends Error {
  code: string;
  constructor(message: string, code = '') {
    super(message);
    this.name = 'AngelError';
    this.code = code;
  }
}

export interface AngelSession {
  apiKey: string;
  clientCode: string;
  jwtToken: string;
  refreshToken: string;
  feedToken: string;
  /** When the session was made (ms); Angel sessions last the trading day. */
  at: number;
}

const headers = (apiKey: string, jwt?: string): Record<string, string> => ({
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'X-UserType': 'USER',
  'X-SourceID': 'WEB',
  'X-ClientLocalIP': '127.0.0.1',
  'X-ClientPublicIP': '127.0.0.1',
  'X-MACAddress': '00:00:00:00:00:00',
  'X-PrivateKey': apiKey,
  ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
});

const bare = (t: unknown) => String(t ?? '').replace(/^Bearer\s+/i, '');

async function call<T>(url: string, init: RequestInit, what: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new AngelError(`Cannot reach Angel One (${what}): ${(e as Error).message}`);
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok || !json || json.status === false || json.success === false) {
    const code = String(json?.errorcode ?? json?.errorCode ?? '');
    const msg = json?.message || json?.errorMessage || text.slice(0, 160) || `HTTP ${res.status}`;
    throw new AngelError(`Angel One ${what}: ${msg}${code ? ` (${code})` : ''}`, code);
  }
  return json as T;
}

/** Log in: client code + MPIN + the 6-digit TOTP code. */
export async function angelLogin(o: {
  apiKey: string;
  clientCode: string;
  pin: string;
  totp: string;
  baseUrl?: string;
  now?: number;
}): Promise<AngelSession> {
  if (!o.apiKey.trim()) throw new AngelError('Enter the Angel One SmartAPI API key');
  if (!o.clientCode.trim()) throw new AngelError('Enter the Angel One client code');
  if (!/^\d{4,6}$/.test(o.pin)) throw new AngelError('Enter your Angel One MPIN (4–6 digits)');
  const json = await call<any>(
    `${o.baseUrl || ANGEL_API_URL}/rest/auth/angelbroking/user/v1/loginByPassword`,
    {
      method: 'POST',
      headers: headers(o.apiKey.trim()),
      body: JSON.stringify({ clientcode: o.clientCode.trim().toUpperCase(), password: o.pin, totp: o.totp }),
    },
    'login',
  );
  const d = json.data ?? {};
  if (!d.jwtToken) throw new AngelError('Angel One login: no session token in the reply');
  return {
    apiKey: o.apiKey.trim(),
    clientCode: o.clientCode.trim().toUpperCase(),
    jwtToken: bare(d.jwtToken),
    refreshToken: bare(d.refreshToken),
    feedToken: String(d.feedToken ?? ''),
    at: o.now ?? Date.now(),
  };
}

/** Exchange → tokens, e.g. { NSE: ['99926009'], NFO: ['43210', …] } (at most 50 tokens per call). */
export type ExchangeTokens = Record<string, string[]>;

export class AngelClient {
  session: AngelSession | null = null;
  private baseUrl: string;
  // Conservative pacing (Angel's per-second limits are per API); shared by the engine and its ticks.
  private quoteThrottle = new Throttle(1050);
  private dataThrottle = new Throttle(400);
  private slowThrottle = new Throttle(1100);

  constructor(o: { baseUrl?: string; session?: AngelSession | null } = {}) {
    this.baseUrl = o.baseUrl || ANGEL_API_URL;
    this.session = o.session ?? null;
  }

  get connected() {
    return !!this.session?.jwtToken;
  }

  private post<T>(path: string, body: unknown, what: string): Promise<T> {
    const s = this.session;
    if (!s) return Promise.reject(new AngelError('Angel One is not logged in — Settings → Angel One'));
    return call<T>(`${this.baseUrl}${path}`, { method: 'POST', headers: headers(s.apiKey, s.jwtToken), body: JSON.stringify(body) }, what);
  }

  /** mode 'LTP' (price only) or 'FULL' (with OI, volume, depth). */
  async quote(mode: 'LTP' | 'OHLC' | 'FULL', exchangeTokens: ExchangeTokens): Promise<any[]> {
    const json = await this.quoteThrottle.run(() =>
      this.post<any>('/rest/secure/angelbroking/market/v1/quote/', { mode, exchangeTokens }, 'quote'),
    );
    return json?.data?.fetched ?? [];
  }

  /** 5-min (etc.) candles: rows [time, open, high, low, close, volume]. fromdate/todate 'yyyy-MM-dd HH:mm' IST. */
  async candles(p: { exchange: string; symboltoken: string; interval: string; fromdate: string; todate: string }): Promise<any[]> {
    const json = await this.dataThrottle.run(() =>
      this.post<any>('/rest/secure/angelbroking/historical/v1/getCandleData', p, 'candles'),
    );
    return json?.data ?? [];
  }

  /** Option Greeks + IV for one underlying and expiry (expirydate like '27NOV2026'). */
  async optionGreeks(name: string, expirydate: string): Promise<any[]> {
    const json = await this.slowThrottle.run(() =>
      this.post<any>('/rest/secure/angelbroking/marketData/v1/optionGreek', { name, expirydate }, 'option Greeks'),
    );
    return json?.data ?? [];
  }

  /** Contracts matching a search, e.g. ('NFO', 'BANKNIFTY'): [{ tradingsymbol, symboltoken, exchange }]. */
  async searchScrip(exchange: string, searchscrip: string): Promise<any[]> {
    const json = await this.slowThrottle.run(() =>
      this.post<any>('/rest/secure/angelbroking/order/v1/searchScrip', { exchange, searchscrip }, 'contract search'),
    );
    return json?.data ?? [];
  }
}

/** End the session at Angel One (best effort: the phone forgets it either way). */
export async function angelLogout(s: AngelSession, baseUrl?: string): Promise<void> {
  await call(
    `${baseUrl || ANGEL_API_URL}/rest/secure/angelbroking/user/v1/logout`,
    { method: 'POST', headers: headers(s.apiKey, s.jwtToken), body: JSON.stringify({ clientcode: s.clientCode }) },
    'logout',
  ).catch(() => {});
}
