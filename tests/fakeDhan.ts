/// <reference types="node" />
/**
 * In-process fake of the DhanHQ v2 REST API, used by tests and the browser e2e.
 * Response shapes follow Dhan's v2 documentation. It records every request so
 * tests can assert on exactly what would have been sent to Dhan.
 *
 *   node tests/fakeDhan.ts 9900     (standalone)
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';

export interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

export const FAKE_TOKEN = 'fake-access-token';
export const FAKE_CLIENT = '1100000001';
/** Realistic-length token for app UI tests (real Dhan tokens are long JWTs). */
export const FAKE_LONG_TOKEN = `eyJfake.${'x'.repeat(60)}.sig`;
/** Requests for this expiry / 5-minute candles are answered with the workbook's real 27-Aug-2026 data. */
export const GOLDEN_EXPIRY = '2099-12-29';

let golden: any = null;
const goldenFixture = () =>
  (golden ??= JSON.parse(readFileSync(new URL('./fixtures/workbook-2026-08-27.json', import.meta.url), 'utf8')));

/** Workbook fixture → Dhan /charts/intraday response shape. */
function goldenIntraday() {
  const c = goldenFixture().candles as any[];
  return {
    open: c.map((x) => x.o),
    high: c.map((x) => x.h),
    low: c.map((x) => x.l),
    close: c.map((x) => x.c),
    volume: c.map((x) => x.v),
    timestamp: c.map((x) => x.t / 1000),
  };
}

// ---- MCX (commodity futures) --------------------------------------------------

/** Gold Mini contracts the fake instrument list knows (detailed-format CSV, as /v2/instrument/MCX_COMM). */
export const MCX_CONTRACTS = [
  { id: '445566', symbol: 'GOLDM', trading: 'GOLDM-Nov2026-FUT', expiry: '2026-11-05', tick: 1 },
  { id: '445577', symbol: 'GOLDM', trading: 'GOLDM-Dec2026-FUT', expiry: '2026-12-04', tick: 1 },
  { id: '445588', symbol: 'GOLDM', trading: 'GOLDM-Jan2027-FUT', expiry: '2027-01-05', tick: 1 },
  { id: '778899', symbol: 'LEADMINI', trading: 'LEADMINI-Nov2026-FUT', expiry: '2026-11-28', tick: 0.05 },
];

function mcxInstrumentCsv() {
  const head =
    'EXCH_ID,SEGMENT,SECURITY_ID,ISIN,INSTRUMENT,UNDERLYING_SECURITY_ID,UNDERLYING_SYMBOL,SYMBOL_NAME,DISPLAY_NAME,INSTRUMENT_TYPE,SERIES,LOT_SIZE,SM_EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE,TICK_SIZE,EXPIRY_FLAG';
  const rows = MCX_CONTRACTS.map(
    (c) =>
      `MCX,M,${c.id},NA,FUTCOM,1,${c.symbol},${c.trading},${c.symbol} FUT,FUT,NA,1.0,${c.expiry} 23:59:00,0.00000,XX,${c.tick},M`,
  );
  // An option row and another exchange's row that must be ignored.
  rows.push(
    'MCX,M,999001,NA,OPTFUT,1,GOLDM,GOLDM-Dec2026-120000-CE,GOLDM CE,OP,NA,1.0,2026-11-25 23:59:00,120000.00000,CE,0.5,M',
  );
  rows.push(
    'NSE,D,35000,NA,FUTIDX,13,NIFTY,NIFTY-Nov2026-FUT,NIFTY FUT,FUT,NA,65.0,2026-11-24 14:30:00,0.00000,XX,0.05,M',
  );
  return [head, ...rows].join('\n');
}

/**
 * Gold Mini 5-min candles: three sessions trending DOWN with rising open interest
 * (short buildup) — the futures model should favour SHORT.
 */
function mcxCandles(securityId: string) {
  const base = securityId === '778899' ? 180 : 120000;
  const step = base * 0.0004;
  const out = {
    open: [] as number[],
    high: [] as number[],
    low: [] as number[],
    close: [] as number[],
    volume: [] as number[],
    open_interest: [] as number[],
    timestamp: [] as number[],
  };
  let price = base;
  let oi = 20000;
  for (let day = 0; day < 3; day++) {
    const start = Date.UTC(2026, 9, 28 + day, 3, 30) / 1000; // 09:00 IST
    for (let i = 0; i < 75; i++) {
      const o = price;
      const wobble = ((i * 7919) % 13) / 13 - 0.35; // deterministic noise, net down
      const c = o - step * (0.6 + wobble);
      out.open.push(o);
      out.close.push(c);
      out.high.push(Math.max(o, c) + step * 0.3);
      out.low.push(Math.min(o, c) - step * 0.3);
      out.volume.push(1000 + ((i * 31) % 17) * 40 + (i === 74 ? 2500 : 0));
      oi += 35;
      out.open_interest.push(oi);
      out.timestamp.push(start + i * 300);
      price = c;
    }
  }
  return out;
}
const mcxLast = (securityId: string) => mcxCandles(securityId).close.at(-1)!;

/** Premium of a golden-chain option by the security id goldenChain() assigns. */
function goldenLtp(securityId: string): number | null {
  const n = Number(securityId);
  const type = n >= 70000 ? 'pe' : n >= 60000 ? 'ce' : null;
  if (!type) return null;
  const strike = (n - (type === 'ce' ? 60000 : 70000)) * 50;
  const s = goldenFixture().chain.strikes.find((x: any) => x.strike === strike);
  return s?.[type]?.ltp || null;
}

/** Workbook fixture → Dhan /optionchain response shape. */
function goldenChain() {
  const fx = goldenFixture();
  const oc: any = {};
  for (const s of fx.chain.strikes) {
    const leg = (l: any, type: 'CE' | 'PE') => ({
      security_id: (type === 'CE' ? 60000 : 70000) + Math.round(s.strike / 50),
      last_price: l.ltp,
      oi: l.oi,
      previous_oi: l.prevOi,
      volume: l.volume,
      implied_volatility: l.iv,
      greeks: { delta: l.delta, gamma: l.gamma, theta: l.theta, vega: l.vega },
    });
    oc[`${s.strike.toFixed(6)}`] = { ce: leg(s.ce, 'CE'), pe: leg(s.pe, 'PE') };
  }
  return { data: { last_price: fx.chain.spot, oc }, status: 'success' };
}

const istStamp = () => {
  const d = new Date(Date.now() + 5.5 * 3600_000);
  return d.toISOString().replace('T', ' ').slice(0, 19);
};

export function startFakeDhan(port = 0): Promise<{ server: Server; url: string; requests: Recorded[]; state: any }> {
  const requests: Recorded[] = [];
  let spot = 25850.5;
  const state = {
    orders: [] as any[],
    nextId: 5000,
    cash: 250000.5,
    /** Tokens the fake accepts; RenewToken adds a new one. */
    tokens: new Set<string>([FAKE_TOKEN, FAKE_LONG_TOKEN]),
    /** What /profile reports as tokenValidity (dd/MM/yyyy HH:mm IST). */
    tokenValidity: '31/12/2099 09:00',
    renewals: 0,
    /** Whitelisted static IPs (GET /ip/getIP). */
    ips: { primary: '', secondary: '' },
    /** What the test public-IP endpoint reports as this device's IP. */
    publicIp: '198.51.100.20',
  };
  const ltpOf = (seg: string, id: string) => {
    if (seg === 'IDX_I') return spot;
    if (seg === 'MCX_COMM') return mcxLast(id);
    // Golden-chain option ids fill at that chain's own premium.
    const g = goldenLtp(id);
    if (seg === 'NSE_FNO' && g) return g;
    if (seg === 'NSE_FNO') return 100 + (Number(id) % 50);
    return 1000 + (Number(id) % 1000);
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? JSON.parse(raw) : undefined;
      const path = (req.url ?? '').replace(/^\/v2/, '');
      requests.push({ method: req.method!, path, headers: req.headers, body });
      const send = (status: number, json: unknown) => {
        // CORS so the web build can be tested in direct mode (the Android app doesn't need it).
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        });
        res.end(JSON.stringify(json));
      };
      if (req.method === 'OPTIONS') return send(204, {});
      // Test-only stand-in for api.ipify.org (GET) and a switch to change it (POST {ip}).
      // Test-only: mark a resting order as filled at a price (POST {orderId, price}).
      if (path === '/__test/fill' && req.method === 'POST') {
        const o = state.orders.find((x) => x.orderId === String(body.orderId));
        if (!o) return send(404, { error: 'no such order' });
        Object.assign(o, { orderStatus: 'TRADED', averageTradedPrice: body.price, filledQty: o.quantity });
        return send(200, o);
      }
      if (path === '/__test/ip') {
        if (req.method === 'POST') state.publicIp = body.ip;
        return send(200, { ip: state.publicIp });
      }
      if (!state.tokens.has(String(req.headers['access-token']))) {
        return send(401, {
          errorType: 'Invalid_Authentication',
          errorCode: 'DH-901',
          errorMessage: 'Client ID or user generated access token is invalid or expired.',
        });
      }
      spot += 0.5;

      if (req.method === 'GET' && path === '/profile') {
        return send(200, {
          dhanClientId: FAKE_CLIENT,
          tokenValidity: state.tokenValidity,
          activeSegment: 'Equity, Derivative',
          dataPlan: 'Active',
        });
      }
      if (req.method === 'GET' && path === '/RenewToken') {
        const t = `fake-renewed-token-${++state.renewals}-${'x'.repeat(16)}`;
        state.tokens.add(t);
        return send(200, { dhanClientId: FAKE_CLIENT, accessToken: t, expiryTime: '2099-12-31T09:00:00' });
      }

      if (req.method === 'POST' && path === '/marketfeed/quote') {
        const data: any = {};
        for (const [seg, ids] of Object.entries(body ?? {})) {
          if (seg === 'dhanClientId') continue;
          data[seg] = {};
          for (const id of ids as number[]) {
            const ltp = ltpOf(seg, String(id));
            data[seg][String(id)] = {
              last_price: ltp,
              net_change: 12.5,
              volume: 1000,
              ohlc: { open: ltp - 5, close: ltp - 12.5, high: ltp + 10, low: ltp - 20 },
            };
          }
        }
        return send(200, { data, status: 'success' });
      }
      if (req.method === 'GET' && path === '/instrument/MCX_COMM') {
        res.writeHead(200, { 'Content-Type': 'text/csv', 'Access-Control-Allow-Origin': '*' });
        return res.end(mcxInstrumentCsv());
      }
      if (req.method === 'POST' && path === '/charts/intraday' && body.exchangeSegment === 'MCX_COMM') {
        return send(200, mcxCandles(String(body.securityId)));
      }
      if (req.method === 'POST' && path === '/charts/intraday' && Number(body.interval) === 5) {
        return send(200, goldenIntraday());
      }
      if (req.method === 'POST' && path === '/optionchain' && body.Expiry === GOLDEN_EXPIRY) {
        return send(200, goldenChain());
      }
      if (req.method === 'POST' && path === '/charts/intraday') {
        const day1 = Math.floor(Date.UTC(2026, 9, 30, 3, 45) / 1000);
        const day2 = Math.floor(Date.UTC(2026, 9, 31, 3, 45) / 1000);
        const ts = [day1, day1 + 60, day2, day2 + 60, day2 + 120];
        return send(200, {
          open: [1, 2, 3, 4, 5],
          high: [1, 2, 3, 4, 5],
          low: [1, 2, 3, 4, 5],
          close: [10, 11, 20, 21, 22],
          volume: [1, 1, 1, 1, 1],
          timestamp: ts,
        });
      }
      if (req.method === 'POST' && path === '/optionchain/expirylist') {
        return send(200, { data: ['2020-01-07', '2099-01-06', '2099-01-13', '2099-01-20'], status: 'success' });
      }
      if (req.method === 'POST' && path === '/optionchain') {
        const oc: any = {};
        for (let k = 25000; k <= 26700; k += 50) {
          const leg = (type: string) => ({
            last_price: type === 'ce' ? Math.max(1, 26000 - k) / 5 + 10 : Math.max(1, k - 25500) / 5 + 10,
            implied_volatility: 11.5,
            greeks: { delta: type === 'ce' ? 0.5 : -0.5, theta: -10, gamma: 0.001, vega: 10 },
            oi: 100000,
            security_id: (type === 'ce' ? 40000 : 50000) + (k - 25000) / 50,
          });
          oc[`${k}.000000`] = { ce: leg('ce'), pe: leg('pe') };
        }
        return send(200, { data: { last_price: spot, oc }, status: 'success' });
      }
      if (req.method === 'GET' && path === '/fundlimit') {
        return send(200, {
          dhanClientId: FAKE_CLIENT,
          availabelBalance: state.cash,
          sodLimit: 300000,
          utilizedAmount: 49999.5,
        });
      }
      if (req.method === 'GET' && path === '/positions') {
        return send(200, [
          {
            dhanClientId: FAKE_CLIENT,
            tradingSymbol: 'RELIANCE',
            securityId: '2885',
            positionType: 'LONG',
            exchangeSegment: 'NSE_EQ',
            productType: 'INTRADAY',
            buyAvg: 1500,
            buyQty: 10,
            sellAvg: 0,
            sellQty: 0,
            netQty: 10,
            realizedProfit: 0,
            unrealizedProfit: 120,
          },
          {
            dhanClientId: FAKE_CLIENT,
            tradingSymbol: 'NIFTY-Jan2099-26000-CE',
            securityId: '40020',
            positionType: 'LONG',
            exchangeSegment: 'NSE_FNO',
            productType: 'MARGIN',
            buyAvg: 80,
            buyQty: 65,
            netQty: 65,
            realizedProfit: 0,
            unrealizedProfit: -50,
            drvExpiryDate: '2099-01-06 14:30:00',
            drvOptionType: 'CALL',
            drvStrikePrice: 26000,
          },
          {
            dhanClientId: FAKE_CLIENT,
            tradingSymbol: 'SBIN',
            securityId: '3045',
            positionType: 'CLOSED',
            exchangeSegment: 'NSE_EQ',
            productType: 'INTRADAY',
            buyAvg: 900,
            sellAvg: 910,
            netQty: 0,
            realizedProfit: 250,
          },
        ]);
      }
      if (req.method === 'GET' && path === '/holdings') {
        return send(200, [
          {
            exchange: 'NSE',
            tradingSymbol: 'TATASTEEL',
            securityId: '3499',
            isin: 'INE081A01020',
            totalQty: 20,
            availableQty: 20,
            avgCostPrice: 140.25,
          },
        ]);
      }
      if (req.method === 'GET' && path === '/orders') return send(200, state.orders);
      const one = /^\/orders\/(\w+)$/.exec(path);
      if (req.method === 'GET' && one) {
        const o = state.orders.find((x) => x.orderId === one[1]);
        return o ? send(200, o) : send(404, { errorCode: 'DH-905', errorMessage: 'Order not found' });
      }
      if (req.method === 'GET' && path === '/ip/getIP') {
        return send(200, {
          dhanClientId: FAKE_CLIENT,
          primaryIP: state.ips.primary,
          secondaryIP: state.ips.secondary,
          modifyDatePrimary: '',
        });
      }
      if ((req.method === 'POST' && path === '/ip/setIP') || (req.method === 'PUT' && path === '/ip/modifyIP')) {
        if (body.ipFlag === 'SECONDARY') state.ips.secondary = body.ip;
        else state.ips.primary = body.ip;
        return send(200, { status: 'SUCCESS', message: 'IP saved' });
      }
      if (req.method === 'POST' && path === '/orders') {
        const orderId = String(state.nextId++);
        const isMarket = body.orderType === 'MARKET';
        state.orders.push({
          dhanClientId: FAKE_CLIENT,
          orderId,
          orderStatus: isMarket ? 'TRADED' : 'PENDING',
          transactionType: body.transactionType,
          exchangeSegment: body.exchangeSegment,
          productType: body.productType,
          orderType: body.orderType,
          validity: body.validity,
          securityId: body.securityId,
          tradingSymbol: '',
          quantity: body.quantity,
          price: body.price,
          triggerPrice: body.triggerPrice,
          averageTradedPrice: isMarket ? ltpOf(body.exchangeSegment, body.securityId) : 0,
          filledQty: isMarket ? body.quantity : 0,
          createTime: istStamp(),
          updateTime: istStamp(),
        });
        return send(200, { orderId, orderStatus: isMarket ? 'TRADED' : 'PENDING' });
      }
      if (req.method === 'DELETE' && one) {
        const o = state.orders.find((x) => x.orderId === one[1]);
        if (!o) return send(404, { errorCode: 'DH-905', errorMessage: 'Order not found' });
        o.orderStatus = 'CANCELLED';
        return send(200, { orderId: o.orderId, orderStatus: 'CANCELLED' });
      }
      send(404, { errorCode: 'DH-905', errorMessage: `No route ${req.method} ${path}` });
    });
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}/v2`, requests, state });
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startFakeDhan(Number(process.argv[2] ?? 9900)).then(({ url }) => console.log(`Fake Dhan on ${url}`));
}
