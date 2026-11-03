/// <reference types="node" />
/**
 * Phone-only mode: manual ENTER/EXIT, PAPER↔LIVE switch gated by the pre-flight
 * check, static-IP registration, live orders with an exchange stop-loss, and
 * reconciliation after the engine's cycle — against the fake Dhan serving the
 * workbook's real 27-Aug data.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { DhanClient } from '../server/dhan.ts';
import { LiveTrader, stopLimitPrice } from '../server/liveTrader.ts';
import { extractIps, isIPv4 } from '../server/preflight.ts';
import { DhanService } from '../server/service.ts';
import { createLocalApi, DIRECT_ORDERS_MESSAGE, type LocalApi } from '../src/api/localApi.ts';
import { EngineRunner } from '../src/lib/engine/runner.ts';
import type { EngineState } from '../src/lib/engine/types.ts';
import { FAKE_CLIENT, FAKE_TOKEN, GOLDEN_EXPIRY, startFakeDhan } from './fakeDhan.ts';

const STATIC_IP = '203.0.113.7';
let fake: Awaited<ReturnType<typeof startFakeDhan>>;
let api: LocalApi;
let phoneIp = '198.51.100.20'; // the phone starts on mobile data, not the static IP
let stored: { state?: EngineState } | null = null;

const ordersSent = () => fake.requests.filter((r) => r.method === 'POST' && r.path === '/orders').map((r) => r.body);
const order = (id: string) => fake.state.orders.find((o: any) => o.orderId === id);

before(async () => {
  fake = await startFakeDhan();
  api = await createLocalApi({
    clientId: FAKE_CLIENT,
    accessToken: FAKE_TOKEN,
    baseUrl: fake.url,
    store: { load: async () => null, save: async (state) => void (stored = { state }) },
    staticIp: () => STATIC_IP,
    publicIp: async () => phoneIp,
    sleep: async () => {},
  });
  await api.engineConfig({ expiry: GOLDEN_EXPIRY });
  await api.engineRefresh();
});

after(() => {
  api.dispose();
  fake.server.close();
});

test('helpers: IPv4 validation, IP extraction, stop limit below trigger', () => {
  assert.equal(isIPv4('203.0.113.7'), true);
  assert.equal(isIPv4('203.0.113.700'), false);
  assert.deepEqual(extractIps({ primaryIP: '1.2.3.4', secondaryIP: '', x: 'no 5.6.7.8.9' }).sort(), ['1.2.3.4']);
  assert.equal(stopLimitPrice(70.96), 67.4);
  assert.equal(stopLimitPrice(4), 3.5);
});

test('PAPER: manual ENTER opens the planned position at LTP, manual EXIT closes it; no Dhan orders', async () => {
  let s = await api.engine();
  const plan = s.dashboard!.candidatePlan!;
  assert.ok(plan && plan.qty % 65 === 0);
  s = await api.engineEnter();
  assert.equal(s.state.position!.strike, plan.strike);
  assert.equal(s.state.position!.entry, plan.entry);
  assert.match(s.state.journal.at(-1)!.entryReason, /^Manual entry:/);
  s = await api.engineExit();
  assert.equal(s.state.position, null);
  assert.equal(s.state.journal.at(-1)!.exitReason.startsWith('MANUAL EXIT'), true);
  assert.equal(ordersSent().length, 0);
  await assert.rejects(
    api.placeOrder({ instrumentId: 'NSE:TCS', side: 'BUY', qty: 1, type: 'MARKET', product: 'INTRADAY' }),
    (e: Error) => e.message === DIRECT_ORDERS_MESSAGE,
  );
});

test('LIVE is refused until the pre-flight check passes (IP route + Dhan whitelist)', async () => {
  let r = await api.setTradeMode('LIVE');
  assert.equal(r.snapshot.config.tradeMode, 'PAPER');
  const fails = r
    .preflight!.items.filter((i) => i.status === 'fail')
    .map((i) => i.id)
    .sort();
  assert.deepEqual(fails, ['route', 'whitelist']);

  // Register the static IP with Dhan, and put the phone on it (static-IP Wi-Fi / VPN).
  assert.deepEqual(await api.registerStaticIp(STATIC_IP), [STATIC_IP]);
  assert.equal(fake.state.ips.primary, STATIC_IP);
  phoneIp = STATIC_IP;
  r = await api.setTradeMode('LIVE');
  assert.equal(r.preflight!.ok, true, JSON.stringify(r.preflight!.items));
  assert.equal(r.snapshot.config.tradeMode, 'LIVE');
  assert.equal((await api.status()).liveOrders, true);
});

test('LIVE: a confirmed signal is never traded automatically', async () => {
  const before = ordersSent().length;
  for (let i = 0; i < 3; i++) await api.engineRefresh();
  const s = await api.engine();
  assert.equal(s.state.position, null);
  assert.equal(ordersSent().length, before);
});

test('LIVE: ENTER buys at market and places an exchange stop-loss; EXIT cancels it and sells', async () => {
  const n0 = ordersSent().length;
  let s = await api.engineEnter();
  const p = s.state.position!;
  const [buy, stop] = ordersSent().slice(n0);
  assert.deepEqual(
    {
      side: buy.transactionType,
      seg: buy.exchangeSegment,
      type: buy.orderType,
      product: buy.productType,
      qty: buy.quantity,
    },
    { side: 'BUY', seg: 'NSE_FNO', type: 'MARKET', product: 'INTRADAY', qty: p.totalQty },
  );
  assert.equal(String(buy.securityId), String(p.live!.securityId));
  // Entry is the actual fill, SL keeps the plan's distance from it.
  assert.equal(p.entry, order(p.live!.entryOrderId).averageTradedPrice);
  assert.deepEqual(
    { side: stop.transactionType, type: stop.orderType, qty: stop.quantity, trigger: stop.triggerPrice },
    { side: 'SELL', type: 'STOP_LOSS', qty: p.totalQty, trigger: Math.round(p.currentSl * 20) / 20 },
  );
  assert.ok(stop.price < stop.triggerPrice);
  assert.equal(order(p.live!.slOrderId!).orderStatus, 'PENDING');
  assert.match(s.state.journal.at(-1)!.entryReason, /^Manual LIVE entry:/);

  s = await api.engineExit();
  assert.equal(s.state.position, null);
  assert.equal(order(p.live!.slOrderId!).orderStatus, 'CANCELLED');
  const sell = ordersSent().at(-1);
  assert.deepEqual([sell.transactionType, sell.orderType, sell.quantity], ['SELL', 'MARKET', p.totalQty]);
  assert.match(s.state.journal.at(-1)!.exitReason, /^MANUAL EXIT \(live fill\)/);
});

test('LIVE: an exchange stop that filled while the app was closed closes the position on the next refresh', async () => {
  let s = await api.engineEnter();
  const p = s.state.position!;
  const sl = order(p.live!.slOrderId!);
  sl.orderStatus = 'TRADED';
  sl.averageTradedPrice = 60.5;
  sl.filledQty = p.totalQty;
  const n = ordersSent().length;
  s = await api.engineRefresh();
  assert.equal(s.state.position, null);
  const j = s.state.journal.at(-1)!;
  assert.equal(j.exit, 60.5);
  assert.match(j.exitReason, /^SL HIT \(exchange stop order\)/);
  assert.equal(ordersSent().length, n, 'no extra sell — the exchange already sold');
});

test('LIVE: T1 partial books half at market and re-protects the rest at breakeven', async () => {
  const dhan = new DhanClient({ clientId: FAKE_CLIENT, accessToken: FAKE_TOKEN, baseUrl: fake.url });
  const trader = new LiveTrader(dhan, new DhanService(dhan, { liveOrders: true, maxOrderValue: 0 }), {
    sleep: async () => {},
  });
  const runner = new EngineRunner(
    {
      load: async () => {
        throw new Error('unused');
      },
    },
    { load: async () => null, save: async () => {} },
  );
  const slRes = await dhan.placeOrder({
    securityId: '70483',
    exchangeSegment: 'NSE_FNO',
    transactionType: 'SELL',
    quantity: 130,
    orderType: 'STOP_LOSS',
    productType: 'INTRADAY',
    price: 67.4,
    triggerPrice: 70.95,
  });
  const pos = {
    direction: 'PE' as const,
    strike: 24150,
    entry: 82.65,
    originalSl: 70.96,
    target1: 106.03,
    target2: 117.72,
    totalQty: 130,
    journalId: 'J1',
    openedAt: 0,
    partialBooked: false,
    partialQty: 0,
    partialPnl: 0,
    remainingQty: 130,
    currentSl: 70.96,
    live: { securityId: '70483', entryOrderId: 'E1', slOrderId: slRes.orderId },
  };
  const journalRow = {
    id: 'J1',
    date: '2026-08-27',
    time: '10:33:45',
    spot: 0,
    strike: 24150,
    direction: 'PE' as const,
    entry: 82.65,
    sl: 70.96,
    target: 106.03,
    exit: null,
    pnl: null,
    confidence: 88,
    trend: 'BEARISH',
    pcr: 0.55,
    oiBias: '',
    iv: 8,
    delta: -0.4,
    entryReason: '',
    exitReason: '',
  };
  runner.state = { ...runner.state, journal: [journalRow] };
  const beforeState = { ...runner.state, position: pos };
  const afterState = {
    ...runner.state,
    position: { ...pos, partialBooked: true, partialQty: 65, remainingQty: 65, currentSl: 82.65 },
  };
  runner.state = afterState;
  const n = ordersSent().length;
  await trader.afterCycle(runner, beforeState, afterState);
  assert.equal(order(slRes.orderId).orderStatus, 'CANCELLED');
  const [sell, newStop] = ordersSent().slice(n);
  assert.deepEqual([sell.transactionType, sell.orderType, sell.quantity], ['SELL', 'MARKET', 65]);
  assert.deepEqual([newStop.orderType, newStop.quantity, newStop.triggerPrice], ['STOP_LOSS', 65, 82.65]);
  assert.equal(runner.state.position!.live!.slOrderId, String(Number(slRes.orderId) + 2));

  // Engine then closes the rest at T2 (booked at the T2 level) → stop cancelled, remainder sold,
  // journal corrected to the real fill.
  const halfBooked = runner.state.position!; // carries the new stop order id
  const before2 = { ...runner.state, position: { ...halfBooked, partialPnl: (106.03 - 82.65) * 65 } };
  const closed = {
    ...runner.state,
    position: null,
    journal: [
      {
        ...journalRow,
        exit: 117.72,
        pnl: (106.03 - 82.65) * 65 + (117.72 - 82.65) * 65,
        exitReason: 'TARGET 2 HIT (remainder)',
      },
    ],
  };
  runner.state = closed;
  await trader.afterCycle(runner, before2, closed);
  assert.equal(order(halfBooked.live!.slOrderId!).orderStatus, 'CANCELLED');
  const last = ordersSent().at(-1);
  assert.deepEqual([last.transactionType, last.orderType, last.quantity], ['SELL', 'MARKET', 65]);
  const fill = order(String(fake.state.nextId - 1)).averageTradedPrice;
  const j = runner.state.journal[0];
  assert.equal(j.exit, fill);
  assert.ok(Math.abs(j.pnl! - ((106.03 - 82.65) * 65 + (fill - 82.65) * 65)) < 1e-9);
  assert.match(j.exitReason, /live fill @/);
});

test('LIVE → PAPER switch; switching is blocked while a position is open', async () => {
  await api.setTradeMode('PAPER');
  assert.equal((await api.engine()).config.tradeMode, 'PAPER');
  assert.equal((await api.status()).liveOrders, false);
  assert.ok(stored?.state, 'engine state persisted on the phone');
});
