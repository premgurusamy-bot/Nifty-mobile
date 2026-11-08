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

const headers = (apiKey: string, jwt?: string, publicIp = '127.0.0.1'): Record<string, string> => ({
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'X-UserType': 'USER',
  'X-SourceID': 'WEB',
  'X-ClientLocalIP': '127.0.0.1',
  'X-ClientPublicIP': publicIp || '127.0.0.1',
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
  /** The public IP sent with every later call too (the static IP), so the session matches them. */
  publicIp?: string;
}): Promise<AngelSession> {
  if (!o.apiKey.trim()) throw new AngelError('Enter the Angel One SmartAPI API key');
  if (!o.clientCode.trim()) throw new AngelError('Enter the Angel One client code');
  if (!/^\d{4,6}$/.test(o.pin)) throw new AngelError('Enter your Angel One MPIN (4–6 digits)');
  const json = await call<any>(
    `${o.baseUrl || ANGEL_API_URL}/rest/auth/angelbroking/user/v1/loginByPassword`,
    {
      method: 'POST',
      headers: headers(o.apiKey.trim(), undefined, o.publicIp),
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

  private tradeThrottle = new Throttle(150);
  /** The static IP registered on the SmartAPI app (sent with orders). */
  publicIp: () => string;

  constructor(o: { baseUrl?: string; session?: AngelSession | null; publicIp?: () => string } = {}) {
    this.baseUrl = o.baseUrl || ANGEL_API_URL;
    this.session = o.session ?? null;
    this.publicIp = o.publicIp ?? (() => '');
  }

  get connected() {
    return !!this.session?.jwtToken;
  }

  private post<T>(path: string, body: unknown, what: string): Promise<T> {
    const s = this.session;
    if (!s) return Promise.reject(new AngelError('Angel One is not logged in — Settings → Angel One', 'NOT_LOGGED_IN'));
    return call<T>(
      `${this.baseUrl}${path}`,
      { method: 'POST', headers: headers(s.apiKey, s.jwtToken, this.publicIp()), body: JSON.stringify(body) },
      what,
    );
  }

  private get<T>(path: string, what: string): Promise<T> {
    const s = this.session;
    if (!s) return Promise.reject(new AngelError('Angel One is not logged in — Settings → Angel One', 'NOT_LOGGED_IN'));
    return call<T>(`${this.baseUrl}${path}`, { method: 'GET', headers: headers(s.apiKey, s.jwtToken, this.publicIp()) }, what);
  }

  /** The logged-in client's profile (the simplest call that needs the session + API key). */
  async profile(): Promise<any> {
    const json = await this.slowThrottle.run(() => this.get<any>('/rest/secure/angelbroking/user/v1/getProfile', 'profile'));
    return json?.data ?? {};
  }

  /**
   * Step-by-step check of the Angel One connection: which calls work, and whether the public IP
   * sent in the headers matters. For fixing a connection problem (or sending to Angel's support).
   */
  async diagnose(o: { staticIp: string; phoneIp: string }): Promise<string[]> {
    const lines: string[] = [];
    const s = this.session;
    if (!s) return ['Not logged in to Angel One'];
    lines.push(`Client ${s.clientCode} · API key …${s.apiKey.slice(-4)} (${s.apiKey.length} chars) · logged in ${new Date(s.at).toLocaleTimeString()}`);
    const step = async (name: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        lines.push(`✓ ${name}`);
        return true;
      } catch (e) {
        lines.push(`✗ ${name}: ${(e as Error).message.replace(/^Angel One [^:]*: /, '')}`);
        return false;
      }
    };
    const ipOf = this.publicIp;
    const ips = [...new Set([o.staticIp, o.phoneIp, '127.0.0.1'].filter(Boolean))];
    for (const ip of ips) {
      this.publicIp = () => ip;
      const label = ip === o.staticIp ? 'static IP' : ip === o.phoneIp ? "phone's current IP" : 'no IP';
      await step(`profile (sending ${label} ${ip})`, () => this.profile());
    }
    this.publicIp = ipOf;
    await step('index price (quote LTP)', () => this.quote('LTP', { NSE: ['99926009'] }));
    await step('5-min candles', () =>
      this.candles({ exchange: 'NSE', symboltoken: '99926009', interval: 'FIVE_MINUTE', fromdate: '2026-01-01 09:15', todate: '2026-01-01 15:30' }).catch((e) => {
        if (/no data|AB9019/i.test((e as Error).message)) return []; // a holiday window is fine: the call itself worked
        throw e;
      }),
    );
    await step('contract search (BANKNIFTY options)', () => this.searchScrip('NFO', 'BANKNIFTY'));
    await step('funds (RMS)', () => this.rms());
    if (o.staticIp && o.phoneIp && o.staticIp !== o.phoneIp)
      lines.push(`Note: the phone is on ${o.phoneIp}, not the static IP ${o.staticIp} — Angel One / Dhan orders need the static IP's network.`);
    return lines;
  }

  // ---- Orders (NFO options) ----------------------------------------------------

  /** Place an order; returns Angel's order id. Values are sent as strings, like Angel's own client. */
  async placeOrder(p: {
    variety: 'NORMAL' | 'STOPLOSS';
    tradingsymbol: string;
    symboltoken: string;
    transactiontype: 'BUY' | 'SELL';
    exchange: string;
    ordertype: 'MARKET' | 'LIMIT' | 'STOPLOSS_LIMIT';
    producttype: 'INTRADAY' | 'CARRYFORWARD';
    price: number;
    triggerprice?: number;
    quantity: number;
  }): Promise<string> {
    const body = {
      ...p,
      duration: 'DAY',
      price: String(p.price),
      triggerprice: String(p.triggerprice ?? 0),
      quantity: String(p.quantity),
      squareoff: '0',
      stoploss: '0',
    };
    const json = await this.tradeThrottle.run(() =>
      this.post<any>('/rest/secure/angelbroking/order/v1/placeOrder', body, 'order'),
    );
    const id = json?.data?.orderid;
    if (!id) throw new AngelError(`Angel One order: no order id in the reply (${json?.message ?? 'unknown'})`, 'NO_ORDER_ID');
    return String(id);
  }

  async cancelOrder(orderid: string, variety: string) {
    await this.tradeThrottle.run(() =>
      this.post<any>('/rest/secure/angelbroking/order/v1/cancelOrder', { variety, orderid }, 'cancel'),
    );
  }

  /** Today's orders (Angel's order book). */
  async orderBook(): Promise<any[]> {
    const json = await this.slowThrottle.run(() => this.get<any>('/rest/secure/angelbroking/order/v1/getOrderBook', 'order book'));
    return Array.isArray(json?.data) ? json.data : [];
  }

  /** Funds (RMS): available cash etc. */
  async rms(): Promise<any> {
    const json = await this.slowThrottle.run(() => this.get<any>('/rest/secure/angelbroking/user/v1/getRMS', 'funds'));
    return json?.data ?? {};
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

/** Angel One RMS → the balance available to trade (₹): net available margin, else available cash. */
export function angelFunds(rms: any): number {
  const net = Number(rms?.net);
  if (Number.isFinite(net) && net > 0) return net;
  const cash = Number(rms?.availablecash);
  return Number.isFinite(cash) ? cash : 0;
}

/** End the session at Angel One (best effort: the phone forgets it either way). */
export async function angelLogout(s: AngelSession, baseUrl?: string): Promise<void> {
  await call(
    `${baseUrl || ANGEL_API_URL}/rest/secure/angelbroking/user/v1/logout`,
    { method: 'POST', headers: headers(s.apiKey, s.jwtToken), body: JSON.stringify({ clientcode: s.clientCode }) },
    'logout',
  ).catch(() => {});
}
