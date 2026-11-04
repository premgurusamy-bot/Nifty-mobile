/// <reference types="node" />
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';
import { createApp, type ServerConfig } from '../server/index.ts';
import { DhanClient } from '../server/dhan.ts';
import { mapIntraday, mapOrderStatus, mapQuotes, parseIstTimestamp } from '../server/mapping.ts';
import { parseScripMaster } from '../server/scripMaster.ts';
import { DhanService } from '../server/service.ts';
import { istToEpoch } from '../src/lib/time.ts';
import { FAKE_CLIENT, FAKE_TOKEN, GOLDEN_EXPIRY, startFakeDhan, type Recorded } from './fakeDhan.ts';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineRunner } from '../src/lib/engine/runner.ts';
import { DhanEngineSource, FileStore } from '../server/engine.ts';

const KEY = 'test-app-key-0123456789';

// ---- Pure mapping ----------------------------------------------------------

test('mapQuotes derives prevClose from net_change', () => {
  const json = {
    data: {
      NSE_EQ: {
        '2885': { last_price: 1500, net_change: -20, ohlc: { open: 1510, close: 1520, high: 1530, low: 1490 } },
      },
    },
  };
  const [q] = mapQuotes(json, [{ id: 'NSE:RELIANCE', ref: { segment: 'NSE_EQ', securityId: '2885' } }]);
  assert.deepEqual(q, { id: 'NSE:RELIANCE', ltp: 1500, open: 1510, high: 1530, low: 1490, prevClose: 1520 });
});

test('mapIntraday keeps only the latest session', () => {
  const d1 = Math.floor(Date.UTC(2026, 9, 30, 4) / 1000);
  const d2 = Math.floor(Date.UTC(2026, 9, 31, 4) / 1000);
  assert.deepEqual(mapIntraday({ close: [1, 2, 3, 4], timestamp: [d1, d1 + 60, d2, d2 + 60] }), [3, 4]);
});

test('order status and IST timestamps', () => {
  assert.equal(mapOrderStatus('TRADED'), 'FILLED');
  assert.equal(mapOrderStatus('PART_TRADED'), 'OPEN');
  assert.equal(mapOrderStatus('EXPIRED'), 'CANCELLED');
  assert.equal(parseIstTimestamp('2026-11-03 10:15:30'), istToEpoch('2026-11-03', 10, 15) + 30_000);
});

test('scrip master: NIFTY options only (not BANKNIFTY), lot size, equities', () => {
  const csv = [
    'SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_EXPIRY_CODE,SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,SEM_OPTION_TYPE,SEM_TICK_SIZE,SEM_EXPIRY_FLAG',
    'NSE,D,40100,OPTIDX,0,NIFTY-Jan2099-26000-CE,65.0,NIFTY 06 JAN 26000 CALL,2099-01-06 14:30:00,26000.00000,CE,5.0000,W',
    'NSE,D,40101,OPTIDX,0,BANKNIFTY-Jan2099-56000-CE,35.0,BANKNIFTY 27 JAN 56000 CALL,2099-01-27 14:30:00,56000.00000,CE,5.0000,M',
    'NSE,D,30001,OPTIDX,0,NIFTY-Jan2020-12000-PE,75.0,old,2020-01-07 14:30:00,12000.00000,PE,5.0000,W',
    'NSE,E,2885,EQUITY,,RELIANCE,1.0,Reliance Industries,,0.00000,XX,10.0000,NA',
    'BSE,E,500325,EQUITY,,RELIANCE,1.0,Reliance Industries,,0.00000,XX,5.0000,NA',
  ].join('\n');
  const sm = parseScripMaster(csv, new Set(['RELIANCE']));
  assert.equal(sm.options.size, 1);
  assert.equal(sm.options.get('NFO:NIFTY:2099-01-06:26000:CE'), '40100');
  assert.equal(sm.niftyLotSize, 65);
  assert.equal(sm.equities.get('RELIANCE'), '2885');
});

// ---- Integration: app API → bridge → fake Dhan --------------------------------

let fake: Awaited<ReturnType<typeof startFakeDhan>>;
let api: Server;
let base = '';
let service: DhanService;
let liveService: DhanService;
let liveApi: Server;
let liveBase = '';

const cfg = (over: Partial<ServerConfig>): ServerConfig => ({
  port: 0,
  host: '127.0.0.1',
  appApiKey: KEY,
  dhanClientId: FAKE_CLIENT,
  dhanAccessToken: FAKE_TOKEN,
  dhanBaseUrl: fake.url,
  scripMasterUrl: '',
  liveOrders: false,
  maxOrderValue: 0,
  corsOrigin: '*',
  dataDir: '',
  ...over,
});

async function listen(server: Server) {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

before(async () => {
  fake = await startFakeDhan();
  const mk = (live: boolean) =>
    new DhanService(new DhanClient({ clientId: FAKE_CLIENT, accessToken: FAKE_TOKEN, baseUrl: fake.url }), {
      liveOrders: live,
      maxOrderValue: 5_000_000,
    });
  service = mk(false);
  liveService = mk(true);
  api = createApp(cfg({}), service);
  liveApi = createApp(cfg({ liveOrders: true }), liveService);
  base = await listen(api);
  liveBase = await listen(liveApi);
});

after(() => {
  service.stop();
  liveService.stop();
  api.close();
  liveApi.close();
  fake.server.close();
});

const call = async (b: string, path: string, init: RequestInit = {}, key = KEY) => {
  const res = await fetch(b + path, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  });
  return { status: res.status, json: (await res.json()) as any };
};
const lastTo = (path: string, method = 'POST'): Recorded =>
  [...fake.requests].reverse().find((r) => r.path === path && r.method === method)!;

test('rejects requests without the app key', async () => {
  const r = await call(base, '/api/status', {}, 'wrong-key-wrong-key-x');
  assert.equal(r.status, 401);
});

test('quotes: sends Dhan auth headers and segment-grouped ids', async () => {
  const r = await call(base, '/api/quotes?ids=' + encodeURIComponent('NSE:NIFTY 50,NSE:RELIANCE,NSE:TCS'));
  assert.equal(r.status, 200);
  assert.equal(r.json.quotes.length, 3);
  const nifty = r.json.quotes.find((q: any) => q.id === 'NSE:NIFTY 50');
  assert.ok(nifty.ltp > 25000);
  assert.equal(nifty.prevClose, nifty.ltp - 12.5);
  const sent = lastTo('/marketfeed/quote');
  assert.equal(sent.headers['access-token'], FAKE_TOKEN);
  assert.equal(sent.headers['client-id'], FAKE_CLIENT);
  assert.deepEqual(sent.body.IDX_I, [13]);
  assert.deepEqual([...sent.body.NSE_EQ].sort(), [11536, 2885]);
});

test('intraday chart uses the right instrument type', async () => {
  const r = await call(base, '/api/intraday?id=' + encodeURIComponent('NSE:NIFTY 50'));
  assert.deepEqual(r.json.points, [20, 21, 22]);
  const sent = lastTo('/charts/intraday');
  assert.equal(sent.body.securityId, '13');
  assert.equal(sent.body.exchangeSegment, 'IDX_I');
  assert.equal(sent.body.instrument, 'INDEX');
  assert.match(sent.body.fromDate, /^\d{4}-\d{2}-\d{2} 09:15:00$/);
});

test('expiries drop past dates; option chain is centred on ATM', async () => {
  const e = await call(base, '/api/expiries');
  assert.deepEqual(e.json.expiries, ['2099-01-06', '2099-01-13', '2099-01-20']);
  const c = await call(base, '/api/optionchain?expiry=2099-01-06');
  assert.equal(c.json.rows.length, 21);
  assert.equal(c.json.rows[10].strike, 25850);
  assert.equal(c.json.rows[10].ce.iv, 0.115);
  assert.equal(lastTo('/optionchain').body.Expiry, '2099-01-06');
  assert.equal(lastTo('/optionchain').body.UnderlyingScrip, 13);
});

test('portfolio merges funds, open positions and holdings', async () => {
  const r = await call(base, '/api/portfolio');
  assert.equal(r.json.cash, 250000.5);
  assert.equal(r.json.realizedPnl, 250);
  const ids = r.json.rows.map((x: any) => x.instrumentId);
  assert.deepEqual(ids, ['NSE:RELIANCE', 'NFO:NIFTY:2099-01-06:26000:CE', 'EXT:NSE_EQ:3499:TATASTEEL']);
});

test('orders are refused unless LIVE_ORDERS is enabled', async () => {
  const r = await call(base, '/api/orders', {
    method: 'POST',
    body: JSON.stringify({ instrumentId: 'NSE:RELIANCE', side: 'BUY', qty: 1, type: 'MARKET', product: 'INTRADAY' }),
  });
  assert.equal(r.status, 403);
  assert.equal(fake.requests.filter((x) => x.path === '/orders' && x.method === 'POST').length, 0);
});

test('live: equity delivery market order maps to CNC', async () => {
  const r = await call(liveBase, '/api/orders', {
    method: 'POST',
    body: JSON.stringify({ instrumentId: 'NSE:RELIANCE', side: 'BUY', qty: 3, type: 'MARKET', product: 'DELIVERY' }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.order.status, 'FILLED');
  assert.equal(r.json.order.instrumentId, 'NSE:RELIANCE');
  const sent = lastTo('/orders');
  assert.deepEqual(
    { ...sent.body },
    {
      validity: 'DAY',
      disclosedQuantity: 0,
      triggerPrice: 0,
      afterMarketOrder: false,
      securityId: '2885',
      exchangeSegment: 'NSE_EQ',
      transactionType: 'BUY',
      quantity: 3,
      orderType: 'MARKET',
      productType: 'CNC',
      price: 0,
      dhanClientId: FAKE_CLIENT,
    },
  );
});

test('live: option limit order learns security id from the chain, rounds to tick, maps to MARGIN', async () => {
  const r = await call(liveBase, '/api/orders', {
    method: 'POST',
    body: JSON.stringify({
      instrumentId: 'NFO:NIFTY:2099-01-06:26000:PE',
      side: 'SELL',
      qty: 130,
      type: 'LIMIT',
      limitPrice: 99.97,
      product: 'DELIVERY',
    }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.order.status, 'OPEN');
  const sent = lastTo('/orders');
  assert.equal(sent.body.securityId, '50020');
  assert.equal(sent.body.exchangeSegment, 'NSE_FNO');
  assert.equal(sent.body.productType, 'MARGIN');
  assert.equal(sent.body.price, 99.95); // nearest 0.05 tick

  const cancel = await call(liveBase, `/api/orders/${r.json.order.id}`, { method: 'DELETE' });
  assert.equal(cancel.status, 200);
  const book = await call(liveBase, '/api/orders');
  assert.equal(book.json.orders.find((o: any) => o.id === r.json.order.id).status, 'CANCELLED');
});

test('live: lot-size and limit validation happen before reaching Dhan', async () => {
  const before = fake.requests.length;
  const bad = await call(liveBase, '/api/orders', {
    method: 'POST',
    body: JSON.stringify({
      instrumentId: 'NFO:NIFTY:2099-01-06:26000:CE',
      side: 'BUY',
      qty: 10,
      type: 'MARKET',
      product: 'INTRADAY',
    }),
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /lot size/);
  const noPrice = await call(liveBase, '/api/orders', {
    method: 'POST',
    body: JSON.stringify({ instrumentId: 'NSE:TCS', side: 'BUY', qty: 1, type: 'LIMIT', product: 'INTRADAY' }),
  });
  assert.equal(noPrice.status, 400);
  assert.equal(fake.requests.length, before);
});

test('expired Dhan token surfaces a clear error', async () => {
  const s = new DhanService(new DhanClient({ clientId: FAKE_CLIENT, accessToken: 'expired', baseUrl: fake.url }), {
    liveOrders: false,
    maxOrderValue: 0,
  });
  const app = createApp(cfg({}), s);
  const b = await listen(app);
  const r = await call(b, '/api/portfolio');
  assert.equal(r.status, 502);
  assert.equal(r.json.code, 'DH-901');
  assert.match(r.json.error, /access token/);
  app.close();
});

// ---- Engine over HTTP, fed by the workbook's real data in Dhan's JSON shape ----

test('engine: refresh via Dhan reproduces the workbook score end-to-end and persists state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-'));
  const dhan = new DhanClient({ clientId: FAKE_CLIENT, accessToken: FAKE_TOKEN, baseUrl: fake.url });
  const engine = new EngineRunner(new DhanEngineSource(dhan), new FileStore(join(dir, 'engine.json')));
  await engine.init();
  await engine.updateConfig({ expiry: GOLDEN_EXPIRY });
  const app = createApp(cfg({}), service, engine);
  const b = await listen(app);

  const r = await call(b, '/api/engine/refresh', { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'Ready', r.json.status);
  const d = r.json.dashboard;
  // Same 88.898 as the workbook (no IV history yet → flat IV threshold, which also scores 10 here).
  assert.ok(Math.abs(d.decision.confidence - 88.89840619701363) < 1e-6, String(d.decision.confidence));
  assert.equal(d.market.atm, 24150);
  assert.equal(d.chain.maxPain, 24200);
  assert.equal(d.decision.signal, 'WAIT');

  const intraday = lastTo('/charts/intraday');
  assert.equal(intraday.body.interval, 5);
  assert.equal(intraday.body.instrument, 'INDEX');
  assert.equal(intraday.body.securityId, '13');
  assert.match(intraday.body.fromDate, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(lastTo('/optionchain').body.Expiry, GOLDEN_EXPIRY);

  const saved = JSON.parse(readFileSync(join(dir, 'engine.json'), 'utf8'));
  assert.equal(saved.state.pending.direction, 'PE');
  assert.equal(saved.config.expiry, GOLDEN_EXPIRY);

  const bad = await call(b, '/api/engine/config', {
    method: 'PUT',
    body: JSON.stringify({ confWatch: 90, confHigh: 80 }),
  });
  assert.equal(bad.status, 400);
  const preset = await call(b, '/api/engine/config', { method: 'PUT', body: JSON.stringify({ symbol: 'BANKNIFTY' }) });
  assert.equal(preset.json.config.underlyingSecurityId, 25);
  assert.equal(preset.json.config.strikeInterval, 100);

  const bt = await call(b, '/api/engine/backtest');
  assert.equal(bt.json.candles, 225);
  app.close();
});

// ---- Token keeper --------------------------------------------------------------

import { TokenKeeper, extractToken, parseTokenValidity } from '../server/tokenKeeper.ts';
import { writeEnvValue } from '../server/envFile.ts';
import { writeFileSync } from 'node:fs';

test('token validity parsing (Dhan "dd/MM/yyyy HH:mm" IST) and token extraction', () => {
  assert.equal(parseTokenValidity('30/03/2025 15:37'), Date.UTC(2025, 2, 30, 10, 7));
  assert.equal(parseTokenValidity('garbage'), null);
  assert.equal(extractToken({ accessToken: 'a'.repeat(30) }), 'a'.repeat(30));
  assert.equal(extractToken({ data: { token: 'b'.repeat(30) } }), 'b'.repeat(30));
  assert.equal(extractToken({ status: 'ok' }), null);
});

test('writeEnvValue replaces one key and keeps the rest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'env-'));
  const p = join(dir, '.env');
  writeFileSync(p, '# c\nDHAN_CLIENT_ID=1\nDHAN_ACCESS_TOKEN=old\nPORT=8787\n');
  writeEnvValue(p, 'DHAN_ACCESS_TOKEN', 'new-token');
  assert.equal(readFileSync(p, 'utf8'), '# c\nDHAN_CLIENT_ID=1\nDHAN_ACCESS_TOKEN=new-token\nPORT=8787\n');
});

test('token keeper: checks profile, renews near expiry, swaps the live token and persists it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tok-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, `DHAN_CLIENT_ID=${FAKE_CLIENT}\nDHAN_ACCESS_TOKEN=${FAKE_TOKEN}\n`);
  const dhan = new DhanClient({ clientId: FAKE_CLIENT, accessToken: FAKE_TOKEN, baseUrl: fake.url });

  // Far from expiry → check only, no renewal.
  fake.state.tokenValidity = '31/12/2099 09:00';
  const k = new TokenKeeper(dhan, { persist: (t) => writeEnvValue(envPath, 'DHAN_ACCESS_TOKEN', t), autoRenew: true });
  await k.tick();
  assert.equal(k.status.ok, true);
  assert.equal(k.status.lastRenewal, null);
  assert.equal(lastTo('/profile', 'GET').headers.dhanclientid, FAKE_CLIENT);

  // Expiring within 2 h → renews.
  const soon = new Date(Date.now() + 5.5 * 3600_000 + 30 * 60_000);
  const p2 = (n: number) => String(n).padStart(2, '0');
  fake.state.tokenValidity = `${p2(soon.getUTCDate())}/${p2(soon.getUTCMonth() + 1)}/${soon.getUTCFullYear()} ${p2(soon.getUTCHours())}:${p2(soon.getUTCMinutes())}`;
  const before = fake.state.renewals;
  await k.tick();
  assert.equal(fake.state.renewals, before + 1);
  assert.ok(k.status.lastRenewal);
  const saved = readFileSync(envPath, 'utf8');
  assert.match(saved, /DHAN_ACCESS_TOKEN=fake-renewed-token-/);
  // The client now uses the renewed token.
  await dhan.fundLimit();
  assert.match(String(lastTo('/fundlimit', 'GET').headers['access-token']), /^fake-renewed-token-/);
  fake.state.tokenValidity = '31/12/2099 09:00';
});

test('token keeper: invalid token reports not ok and /api/status says so', async () => {
  const dhan = new DhanClient({ clientId: FAKE_CLIENT, accessToken: 'expired-token', baseUrl: fake.url });
  const k = new TokenKeeper(dhan, { autoRenew: true });
  await k.tick();
  assert.equal(k.status.ok, false);
  assert.match(k.status.message, /access token/);
  const app = createApp(cfg({}), service, undefined, k);
  const b = await listen(app);
  const r = await call(b, '/api/status');
  assert.equal(r.json.ok, false);
  assert.equal(r.json.token.ok, false);
  app.close();
});

// ---- Direct-to-Dhan mode (the phone talks to Dhan itself) -------------------------

import { createLocalApi, DIRECT_ORDERS_MESSAGE, verifyDhanCredentials } from '../src/api/localApi.ts';

test('direct mode: verify credentials, live quotes, engine reproduces the workbook, orders refused, token renewal saved', async () => {
  assert.equal((await verifyDhanCredentials(FAKE_CLIENT, FAKE_TOKEN, fake.url)) > 20000, true);
  await assert.rejects(verifyDhanCredentials(FAKE_CLIENT, 'wrong-token-wrong-token', fake.url), /access token/);

  let saved: unknown = null;
  const persisted: string[] = [];
  const api = await createLocalApi({
    positionTickMs: 0,
    clientId: FAKE_CLIENT,
    accessToken: FAKE_TOKEN,
    baseUrl: fake.url,
    store: { load: async () => null, save: async (state, config) => void (saved = { state, config }) },
    persistToken: (t) => void persisted.push(t),
  });
  try {
    const st = await api.status();
    assert.equal(st.liveOrders, false);
    const q = await api.quotes(['NSE:NIFTY 50', 'NSE:RELIANCE']);
    assert.equal(q.quotes.length, 2);

    await api.engineConfig({ expiry: GOLDEN_EXPIRY });
    const snap = await api.engineRefresh();
    assert.equal(snap.status, 'Ready');
    assert.ok(Math.abs(snap.dashboard!.decision.confidence - 88.89840619701363) < 1e-6);
    assert.ok(saved, 'engine state persisted to the phone store');

    const chain = await api.optionChain(GOLDEN_EXPIRY);
    assert.equal(chain.rows.length, 21);
    await assert.rejects(
      api.placeOrder({ instrumentId: 'NSE:RELIANCE', side: 'BUY', qty: 1, type: 'MARKET', product: 'INTRADAY' }),
      (e: Error) => e.message === DIRECT_ORDERS_MESSAGE,
    );
  } finally {
    api.dispose();
  }
  assert.deepEqual(persisted, []); // far from expiry → no renewal
});
