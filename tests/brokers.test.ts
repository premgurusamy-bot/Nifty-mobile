/// <reference types="node" />
/**
 * Two brokers: NIFTY orders at Dhan, BANK NIFTY orders at Angel One; an entry the first broker
 * certainly didn't take goes to the other one at once — but never when it's unclear (no double orders).
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { angelLogin, AngelClient } from '../server/angel.ts';
import { AngelEngineSource } from '../server/angelSource.ts';
import { AngelGateway, angelStatus, angelTime } from '../server/brokers.ts';
import { RoutedEngineSource } from '../server/routedSource.ts';
import { DEFAULT_CONFIG, type EngineConfig } from '../src/lib/engine/types.ts';
import { sanitizeConfig } from '../src/lib/engine/runner.ts';
import { totpNow } from '../src/lib/totp.ts';
import { ANGEL_CLIENT, ANGEL_KEY, ANGEL_PIN, ANGEL_TOTP_KEY, startFakeAngel } from './fakeAngel.ts';
import { FAKE_CLIENT, FAKE_TOKEN, GOLDEN_EXPIRY, startFakeDhan } from './fakeDhan.ts';

let fa: Awaited<ReturnType<typeof startFakeAngel>>;
let fd: Awaited<ReturnType<typeof startFakeDhan>>;
before(async () => {
  // Angel's fake on the fake Dhan's strike grid, so a strike priced at one broker exists at the other.
  [fa, fd] = await Promise.all([startFakeAngel(0, { first: 24000, step: 50, count: 81, spot: 24159.1 }), startFakeDhan()]);
});
after(() => {
  fa.server.close();
  fd.server.close();
});
const login = () => angelLogin({ apiKey: ANGEL_KEY, clientCode: ANGEL_CLIENT, pin: ANGEL_PIN, totp: totpNow(ANGEL_TOTP_KEY), baseUrl: fa.url });
const dhanOrders = () => fd.requests.filter((r) => r.method === 'POST' && r.path === '/orders');
const angelOrders = () => fa.requests.filter((r) => r.path.endsWith('/placeOrder'));

/** The phone stack (Dhan + Angel One fakes), BANK NIFTY on Angel data, LIVE. */
async function phone(over: Partial<EngineConfig> = {}, angelLoggedIn = true) {
  const { createLocalApi } = await import('../src/api/localApi.ts');
  const api = await createLocalApi({
    positionTickMs: 0,
    clientId: FAKE_CLIENT,
    accessToken: FAKE_TOKEN,
    baseUrl: fd.url,
    angelBaseUrl: fa.url,
    angelSession: angelLoggedIn ? await login() : null,
    store: { load: async () => null, save: async () => {} },
    staticIp: () => '203.0.113.7',
    publicIp: async () => '198.51.100.20',
    sleep: async () => {},
  });
  await api.engineConfig({
    symbol: 'BANKNIFTY',
    expiry: GOLDEN_EXPIRY,
    lastEntryTime: '',
    angelSymbols: ['BANKNIFTY'],
    angelOrderSymbols: ['BANKNIFTY'],
    ...over,
  });
  await api.engineRefresh();
  await api.runner.updateConfig({ tradeMode: 'LIVE' });
  return api;
}

test('Angel One order status words and times', () => {
  assert.deepEqual(
    ['complete', 'rejected', 'cancelled', 'trigger pending', 'open'].map((status) => angelStatus({ status })),
    ['TRADED', 'REJECTED', 'CANCELLED', 'TRIGGER_PENDING', 'PENDING'],
  );
  assert.equal(angelStatus({ status: 'open', filledshares: '30' }), 'PART_TRADED');
  assert.equal(angelTime('08-Nov-2026 10:15:20'), Date.UTC(2026, 10, 8, 4, 45, 20));
  assert.deepEqual(DEFAULT_CONFIG.angelOrderSymbols, ['FINNIFTY']);
  assert.equal(DEFAULT_CONFIG.brokerFailover, true);
  assert.throws(() => sanitizeConfig({ angelOrderSymbols: ['GOLDM'] }, DEFAULT_CONFIG), /can't trade through Angel One/);
});

test('BANK NIFTY: market BUY + stop-loss at Angel One (nothing at Dhan); EXIT sells at Angel One', async () => {
  const api = await phone();
  try {
    const nd = dhanOrders().length;
    const na = angelOrders().length;
    const s = await api.engineEnter();
    const p = s.state.position!;
    assert.equal(p.live?.broker, 'ANGEL');
    assert.match(p.live!.tradingSymbol!, /^BANKNIFTY29DEC99\d+(CE|PE)$/);
    const [buy, stop] = angelOrders().slice(na).map((r) => r.body);
    assert.deepEqual([buy.variety, buy.ordertype, buy.transactiontype, buy.exchange, buy.producttype], ['NORMAL', 'MARKET', 'BUY', 'NFO', 'INTRADAY']);
    assert.equal(buy.quantity, String(p.totalQty));
    assert.deepEqual([stop.variety, stop.ordertype, stop.transactiontype], ['STOPLOSS', 'STOPLOSS_LIMIT', 'SELL']);
    assert.equal(Number(stop.triggerprice), p.currentSl);
    assert.equal(fa.requests.find((r) => r.path.endsWith('/placeOrder'))!.headers['x-clientpublicip'], '203.0.113.7'); // the static IP
    assert.equal(dhanOrders().length, nd);
    assert.match(s.state.journal.at(-1)!.entryReason, /Angel One/);
    const n2 = angelOrders().length;
    await api.engineExit();
    assert.ok(fa.requests.some((r) => r.path.endsWith('/cancelOrder') && r.body.variety === 'STOPLOSS'));
    const sell = angelOrders().slice(n2)[0].body;
    assert.deepEqual([sell.transactiontype, sell.ordertype], ['SELL', 'MARKET']);
    assert.equal(api.runner.state.position, null);
  } finally {
    api.dispose();
  }
});

test('NIFTY stays at Dhan', async () => {
  const api = await phone({ symbol: 'NIFTY' });
  try {
    const na = angelOrders().length;
    const s = await api.engineEnter();
    assert.equal(s.state.position!.live?.broker, undefined); // Dhan
    assert.equal(angelOrders().length, na);
  } finally {
    api.dispose();
  }
});

test('never miss the entry: Angel One not logged in / rejected / not filled → placed at Dhan', async () => {
  // Not logged in: straight to Dhan.
  let api = await phone({}, false);
  try {
    const nd = dhanOrders().length;
    const s = await api.engineEnter();
    assert.equal(s.state.position!.live?.broker, undefined);
    assert.equal(dhanOrders().length, nd + 2); // buy + stop at Dhan
    assert.match(s.status, /Entered via Dhan \(Angel One: not logged in\)/);
  } finally {
    api.dispose();
  }
  // Rejected at Angel One → Dhan.
  api = await phone();
  fa.state.orderMode = 'reject';
  try {
    const nd = dhanOrders().length;
    const s = await api.engineEnter();
    assert.equal(s.state.position!.live?.broker, undefined);
    assert.equal(dhanOrders().length, nd + 2);
    assert.match(s.status, /Entered via Dhan \(Angel One: Angel One order \d+ REJECTED: RMS: insufficient funds\)/);
  } finally {
    fa.state.orderMode = 'fill';
    api.dispose();
  }
  // Not filled within the window → cancelled at Angel One → Dhan.
  api = await phone();
  fa.state.orderMode = 'hang';
  try {
    const s = await api.engineEnter();
    assert.equal(s.state.position!.live?.broker, undefined);
    assert.equal(fa.state.orders.at(-1).status, 'cancelled');
    assert.match(s.status, /not filled in 5 s — cancelled, no trade/);
  } finally {
    fa.state.orderMode = 'fill';
    api.dispose();
  }
});

test('switch off: the entry fails instead of going to the other broker', async () => {
  const api = await phone({ brokerFailover: false });
  fa.state.orderMode = 'reject';
  try {
    const nd = dhanOrders().length;
    await assert.rejects(api.engineEnter(), /Entry not placed — Angel One: .*REJECTED/);
    assert.equal(dhanOrders().length, nd);
    assert.equal(api.runner.state.position, null);
  } finally {
    fa.state.orderMode = 'fill';
    api.dispose();
  }
});

test('unclear (no reply, can’t check): no second order at the other broker', async () => {
  const api = await phone();
  try {
    // Angel One stops answering after the data refresh.
    const dead = new AngelClient({ baseUrl: 'http://127.0.0.1:9', session: await login() });
    const gw = new AngelGateway(dead, new AngelEngineSource(new AngelClient({ baseUrl: fa.url, session: await login() })));
    (api as any).runner; // the trader is internal: swap its Angel gateway for the dead one
    const { LiveTrader } = await import('../server/liveTrader.ts');
    const { DhanClient } = await import('../server/dhan.ts');
    const { DhanService } = await import('../server/service.ts');
    const dhan = new DhanClient({ clientId: FAKE_CLIENT, accessToken: FAKE_TOKEN, baseUrl: fd.url });
    const trader = new LiveTrader(dhan, new DhanService(dhan, { liveOrders: true, maxOrderValue: 0 }), { sleep: async () => {}, angel: gw });
    const nd = dhanOrders().length;
    await assert.rejects(trader.enter(api.runner), /Cannot reach Angel One.*may or may not have been placed: check Angel One → Orders/);
    assert.equal(dhanOrders().length, nd);
  } finally {
    api.dispose();
  }
});

test('data: Dhan fails → an index Angel One can serve uses Angel One for that refresh', async () => {
  const angel = new AngelClient({ baseUrl: fa.url, session: await login() });
  const broken = { load: async () => { throw new Error('Dhan down'); } };
  const r = new RoutedEngineSource(broken, angel);
  const bank = sanitizeConfig({ symbol: 'BANKNIFTY' }, DEFAULT_CONFIG);
  const d = await r.load(bank, Date.UTC(2099, 11, 29, 6, 0));
  assert.equal(d.chain.feed, 'ANGEL');
  assert.match(d.chain.feedNote!, /Dhan error \(Dhan down\) — using Angel One/);
  await assert.rejects(r.load({ ...bank, brokerFailover: false }, Date.UTC(2099, 11, 29, 6, 0)), /Dhan down/);
});

test('Capital sizing (LIVE, live capital 0): each index sized from its broker’s balance', async () => {
  const api = await phone({ sizingMode: 'CAPITAL', capitalLive: 0, capitalPct: 100, maxLots: 0, multiIndex: true, symbol: 'NIFTY', angelOrderSymbols: ['BANKNIFTY'] });
  try {
    await api.engineRefresh();
    const r = api.runner;
    assert.equal(r.fundsBy.ANGEL, 123456.5); // Angel One RMS net
    assert.equal(r.fundsBy.DHAN, 250000.5); // Dhan available balance
    await r.setActive('NIFTY');
    assert.equal(r.snapshot().capital!.source, 'Dhan available balance');
    await r.setActive('BANKNIFTY');
    assert.deepEqual([r.snapshot().capital!.capital, r.snapshot().capital!.source], [123456.5, 'Angel One available balance']);
    // NIFTY's orders (and balance) can be at Angel One too.
    await r.updateConfig({ angelOrderSymbols: ['BANKNIFTY', 'NIFTY'] });
    await r.setActive('NIFTY');
    assert.equal(r.snapshot().capital!.source, 'Angel One available balance');
    // Angel One logged out (switch on): orders go to Dhan, so Dhan's balance sizes them.
    api.angelSetSession(null);
    assert.equal(r.brokerFor(), 'DHAN');
    assert.equal(r.snapshot().capital!.source, 'Dhan available balance');
  } finally {
    api.dispose();
  }
});

test('a LIVE exit the broker refuses: the stop-loss is put back and an alert is raised (never left unprotected)', async () => {
  const api = await phone({ symbol: 'NIFTY' }); // Dhan
  try {
    await api.engineEnter();
    const p = api.runner.state.position!;
    const oldSl = p.live!.slOrderId;
    fd.state.rejectMarket = 'SELL';
    const n = dhanOrders().length;
    await assert.rejects(api.engineExit(), /REJECTED: RMS: margin shortfall/);
    const sent = dhanOrders().slice(n);
    assert.deepEqual(sent.map((o) => o.body.orderType), ['MARKET', 'STOP_LOSS']); // the sell, then the stop back
    const now = api.runner.state.position!;
    assert.ok(now, 'still open in the app');
    assert.notEqual(now.live!.slOrderId, oldSl); // the new stop is tracked
    const ev = api.runner.state.events[0];
    assert.equal(ev.kind, 'ERROR');
    assert.match(ev.message, /^EXIT FAILED at Dhan: .* still open at Dhan; stop-loss put back at/);
  } finally {
    fd.state.rejectMarket = null;
    api.dispose();
  }
});

test('PAPER/LIVE switching and clearing the journal are refused while ANY watched index has a trade', async () => {
  const api = await phone({ symbol: 'NIFTY', multiIndex: true, watchSymbols: ['NIFTY', 'BANKNIFTY'] });
  try {
    await api.engineEnter(); // NIFTY in a LIVE trade
    await api.engineSetActive('BANKNIFTY'); // looking at the other index
    assert.equal(api.runner.state.position, null);
    await assert.rejects(api.setTradeMode('PAPER'), /NIFTY has an open trade or entry order/);
    await assert.rejects(api.engineResetJournal(), /NIFTY has an open trade/);
    assert.equal(api.runner.config.tradeMode, 'LIVE');
  } finally {
    api.dispose();
  }
});

test('manual actions wait for an engine cycle in progress (never run inside one)', async () => {
  const { EngineRunner } = await import('../src/lib/engine/runner.ts');
  const order: string[] = [];
  const r = new EngineRunner({ load: async () => ({}) as never } as never, { load: async () => null, save: async () => {} });
  let release!: () => void;
  const cycle = (r as any).serial(async () => {
    order.push('cycle start');
    await new Promise<void>((res) => (release = res));
    order.push('cycle end');
  });
  const action = r.exclusive(async () => void order.push('action'));
  await new Promise((res) => setTimeout(res, 20));
  release();
  await Promise.all([cycle, action]);
  assert.deepEqual(order, ['cycle start', 'cycle end', 'action']);
});

test('a LIVE exit that does not fill in time is cancelled (never left working) before the stop goes back', async () => {
  const api = await phone({ symbol: 'NIFTY' });
  try {
    await api.engineEnter();
    fd.state.marketFill = 0; // the sell sits there unfilled
    const n = dhanOrders().length;
    await assert.rejects(api.engineExit(), /not filled in time — cancelled \(0 of \d+ filled\)/);
    assert.equal(fd.state.orders.filter((o: any) => o.orderType === 'MARKET' && o.transactionType === 'SELL').at(-1).orderStatus, 'CANCELLED');
    assert.equal(dhanOrders().slice(n).at(-1)!.body.orderType, 'STOP_LOSS'); // protected again
  } finally {
    fd.state.marketFill = null;
    api.dispose();
  }
});
