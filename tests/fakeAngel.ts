/// <reference types="node" />
/**
 * In-process fake of Angel One SmartAPI (the market-data routes the app uses), with response
 * shapes as Angel's SmartAPI client reads them. Records every request.
 */
import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { totpNow } from '../src/lib/totp.ts';
import type { Recorded } from './fakeDhan.ts';

export const ANGEL_KEY = 'fake-angel-api-key';
export const ANGEL_CLIENT = 'A123456';
export const ANGEL_PIN = '1234';
export const ANGEL_TOTP_KEY = 'JBSWY3DPEHPK3PXP';
export const ANGEL_EXPIRY = '2099-12-30'; // 30DEC2099 → tradingsymbol BANKNIFTY30DEC99…
const SYM_EXP = '30DEC99';

export function startFakeAngel(port = 0): Promise<{ server: Server; url: string; requests: Recorded[]; state: any }> {
  const requests: Recorded[] = [];
  const state = {
    spot: 54210.35,
    jwt: 'fake-angel-jwt',
    /** Make every secured call fail with this Angel error code (e.g. 'AG8001'). */
    failWith: '' as string,
    logins: 0,
  };
  const strikes = Array.from({ length: 61 }, (_, i) => 51000 + i * 100);
  const token = (k: number, t: string) => String((t === 'CE' ? 600000 : 700000) + (k - 51000) / 100);
  const contracts = strikes.flatMap((k) =>
    ['CE', 'PE'].map((t) => ({ exchange: 'NFO', tradingsymbol: `BANKNIFTY${SYM_EXP}${k}${t}`, symboltoken: token(k, t) })),
  );
  const byToken = new Map(contracts.map((c) => [c.symboltoken, c]));
  const premium = (k: number, t: string) => Math.max(5, Math.round((t === 'CE' ? state.spot - k : k - state.spot) * 0.6 + 300));

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const path = (req.url ?? '').split('?')[0];
      requests.push({ method: req.method ?? '', path, headers: req.headers, body });
      const send = (json: unknown, status = 200) => {
        res.writeHead(status, {
          'content-type': 'application/json',
          // Browser e2e only (the phone app has no CORS).
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
        });
        res.end(JSON.stringify(json));
      };
      if (req.method === 'OPTIONS') return send({}, 204);
      const fail = (message: string, errorcode: string) => send({ status: false, message, errorcode, data: null });
      if (req.headers['x-privatekey'] !== ANGEL_KEY) return fail('Invalid API Key', 'AG8004');
      if (path === '/rest/auth/angelbroking/user/v1/loginByPassword') {
        if (body.clientcode !== ANGEL_CLIENT || body.password !== ANGEL_PIN) return fail('Invalid clientcode or password', 'AB1007');
        const ok = [0, -30_000].some((d) => body.totp === totpNow(ANGEL_TOTP_KEY, Date.now() + d)); // one window of slack
        if (!ok) return fail('Invalid totp', 'AB1050');
        state.logins++;
        return send({ status: true, message: 'SUCCESS', errorcode: '', data: { jwtToken: `Bearer ${state.jwt}`, refreshToken: 'fake-refresh', feedToken: 'fake-feed' } });
      }
      if (req.headers.authorization !== `Bearer ${state.jwt}`) return fail('Invalid Token', 'AG8001');
      if (state.failWith) return fail('Invalid Token', state.failWith);
      if (path === '/rest/secure/angelbroking/order/v1/searchScrip') {
        const q = String(body.searchscrip).toUpperCase();
        return send({ status: true, message: 'SUCCESS', data: contracts.filter((c) => c.tradingsymbol.startsWith(q)) });
      }
      if (path === '/rest/secure/angelbroking/historical/v1/getCandleData') {
        const rows = Array.from({ length: 60 }, (_, i) => {
          const c = state.spot - 30 + i;
          return [`2099-12-29T${String(9 + Math.floor((15 + i * 5) / 60)).padStart(2, '0')}:${String((15 + i * 5) % 60).padStart(2, '0')}:00+05:30`, c - 10, c + 15, c - 20, c, 0];
        });
        return send({ status: true, message: 'SUCCESS', data: rows });
      }
      if (path === '/rest/secure/angelbroking/market/v1/quote/') {
        const fetched: any[] = [];
        for (const [ex, toks] of Object.entries(body.exchangeTokens ?? {}) as [string, string[]][]) {
          if (toks.length > 50) return fail('Max 50 tokens', 'AB4001');
          for (const t of toks) {
            if (ex === 'NSE' && t === '99926009') fetched.push({ exchange: 'NSE', tradingSymbol: 'Nifty Bank', symbolToken: t, ltp: state.spot, opnInterest: 0 });
            const c = byToken.get(t);
            if (ex === 'NFO' && c) {
              const m = /(\d+)(CE|PE)$/.exec(c.tradingsymbol)!;
              const k = Number(m[1]);
              fetched.push({ exchange: 'NFO', tradingSymbol: c.tradingsymbol, symbolToken: t, ltp: premium(k, m[2]), opnInterest: 100000 + (k % 1000) * 10, tradeVolume: 50000 });
            }
          }
        }
        return send({ status: true, message: 'SUCCESS', data: { fetched, unfetched: [] } });
      }
      if (path === '/rest/secure/angelbroking/marketData/v1/optionGreek') {
        if (body.name !== 'BANKNIFTY' || body.expirydate !== '30DEC2099') return fail('No data', 'AB9019');
        return send({
          status: true,
          message: 'SUCCESS',
          data: strikes.flatMap((k) =>
            ['CE', 'PE'].map((t) => ({ name: 'BANKNIFTY', expiry: '30DEC2099', strikePrice: `${k}.000000`, optionType: t, delta: t === 'CE' ? '0.5' : '-0.5', gamma: '0.0008', theta: '-12.5', vega: '20.1', impliedVolatility: '14.25', tradeVolume: '50000.00' })),
          ),
        });
      }
      send({ status: false, message: `No route ${path}`, errorcode: 'AB0000' }, 404);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    const a = server.address();
    resolve({ server, url: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`, requests, state });
  }));
}

// Standalone (browser e2e): node tests/fakeAngel.ts 9901
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void startFakeAngel(Number(process.argv[2] ?? 9901)).then(({ url }) => console.log(`fake Angel One on ${url}`));
}
