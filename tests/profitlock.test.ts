/// <reference types="node" />
/** Profit lock: the ₹ ladder, stop raising through T1, T2 off, exit labels, live stop moves at Dhan. */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { DhanClient } from '../server/dhan.ts';
import { LiveTrader } from '../server/liveTrader.ts';
import { DhanService } from '../server/service.ts';
import { categoryOf } from '../src/lib/alerts.ts';
import { checkAndCloseIfHit } from '../src/lib/engine/decision.ts';
import { lockedProfit } from '../src/lib/engine/profitLock.ts';
import { EngineRunner, sanitizeConfig } from '../src/lib/engine/runner.ts';
import { DEFAULT_CONFIG, initialEngineState, type EngineState, type OpenPosition } from '../src/lib/engine/types.ts';
import { FAKE_CLIENT, FAKE_TOKEN, setHolding, startFakeDhan } from './fakeDhan.ts';

const L = { lockStart: 10000, lockStep: 5000, lockRideFrom: 20000, lockRideAmount: 10000 };

test('ladder: one step behind up to the ride level, then trail the ride amount', () => {
  const at = (p: number) => lockedProfit(p, L);
  assert.equal(at(9999), null);
  assert.deepEqual(
    [10000, 14999, 15000, 20000, 25000, 30000, 35000, 42000].map(at),
    [5000, 5000, 10000, 15000, 20000, 20000, 25000, 32000],
  );
  // ride off (0) → keeps stepping
  assert.equal(lockedProfit(42000, { ...L, lockRideFrom: 0 }), 35000);
  assert.equal(lockedProfit(50000, { ...L, lockStart: 0 }), null);
});

test('settings are validated', () => {
  const c = sanitizeConfig({ profitLock: true, lockStart: 8000, lockStep: 4000, lockRideFrom: 16000, lockRideAmount: 6000 }, DEFAULT_CONFIG);
  assert.deepEqual([c.profitLock, c.lockStart, c.lockStep, c.lockRideFrom, c.lockRideAmount], [true, 8000, 4000, 16000, 6000]);
  assert.throws(() => sanitizeConfig({ lockStep: 0 }, DEFAULT_CONFIG), /lockStep/);
  assert.throws(() => sanitizeConfig({ lockStart: 30000 }, DEFAULT_CONFIG), /ride level/);
  assert.equal(DEFAULT_CONFIG.profitLock, false);
});

// Long option: entry 100, 1000 qty (10 lots of 100), T1 105 books half, T2 110 would close the rest.
const cfg = { ...DEFAULT_CONFIG, lotSize: 100, profitLock: true, ...L };
const pos = (): OpenPosition => ({
  direction: 'CE', strike: 24000, entry: 100, originalSl: 95, target1: 105, target2: 110, totalQty: 1000,
  journalId: 'J1', openedAt: 0, partialBooked: false, partialQty: 0, partialPnl: 0, remainingQty: 1000,
  currentSl: 95,
});
const stateWith = (p: OpenPosition): EngineState => ({
  ...initialEngineState(),
  position: p,
  journal: [{ id: 'J1', date: '2026-11-04', time: '10:00:00', spot: 0, strike: 24000, direction: 'CE', entry: 100, sl: 95, target: 105, exit: null, pnl: null, confidence: 85, trend: '', pcr: 0, oiBias: '', iv: 0, delta: 0, entryReason: '', exitReason: '' }],
});

test('paper: T1 still books half, T2 is off, the lock trails and exits as PROFIT LOCK', () => {
  const s = stateWith(pos());
  checkAndCloseIfHit(s, 105, cfg, 1); // T1: half booked (+2,500), stop to breakeven
  assert.equal(s.position!.partialBooked, true);
  assert.equal(s.position!.currentSl, 100);
  checkAndCloseIfHit(s, 112, cfg, 2); // beyond T2 110 → NOT closed (T2 off); profit 2,500 + 6,000
  assert.ok(s.position);
  assert.equal(s.position!.lockedPnl, undefined);
  checkAndCloseIfHit(s, 125, cfg, 3); // profit 15,000 → 10,000 secured → stop 100 + 7,500/500 = 115
  assert.deepEqual([s.position!.peakPnl, s.position!.lockedPnl, s.position!.currentSl], [15000, 10000, 115]);
  assert.equal(s.events[0].kind, 'INFO');
  assert.equal(categoryOf(s.events[0]), 'lock');
  checkAndCloseIfHit(s, 140, cfg, 4); // 22,500 → 15,000 secured → stop 125
  assert.deepEqual([s.position!.lockedPnl, s.position!.currentSl], [15000, 125]);
  checkAndCloseIfHit(s, 130, cfg, 5); // pull-back: stop never moves down
  assert.equal(s.position!.currentSl, 125);
  checkAndCloseIfHit(s, 124, cfg, 6); // below the lock → exit at 125 with 15,000 total
  assert.equal(s.position, null);
  assert.equal(s.journal[0].pnl, 15000);
  assert.match(s.journal[0].exitReason, /^PROFIT LOCK HIT \(Rs 15000 secured\)/);
  assert.equal(categoryOf(s.events[0]), 'lock');
});

test('paper: the lock can engage before T1 (big move in one go) and T1 keeps the higher stop', () => {
  const s = stateWith({ ...pos(), target1: 120, target2: 140 });
  checkAndCloseIfHit(s, 112, cfg, 1); // 12,000 on 1000 qty → 5,000 secured → stop 105
  assert.deepEqual([s.position!.lockedPnl, s.position!.currentSl, s.position!.partialBooked], [5000, 105, false]);
  checkAndCloseIfHit(s, 104, cfg, 2);
  assert.equal(s.position, null);
  assert.equal(s.journal[0].pnl, 5000);
  assert.match(s.journal[0].exitReason, /^PROFIT LOCK HIT/);
});

test('short futures: lock moves the buy-stop DOWN, on the tick', () => {
  const fcfg = { ...cfg, lotSize: 1, tickSize: 1 };
  const s = stateWith({ ...pos(), direction: 'SHORT', entry: 120000, originalSl: 120100, currentSl: 120100, target1: 119000, target2: 118000, totalQty: 1, remainingQty: 1, side: -1, pointValue: 10, symbol: 'GOLDM' });
  checkAndCloseIfHit(s, 118800, fcfg, 1); // 1 lot can't split at T1 → full exit at T1 (T1 kept)
  assert.equal(s.position, null);
  const s2 = stateWith({ ...pos(), direction: 'SHORT', entry: 120000, originalSl: 120100, currentSl: 120100, target1: 110000, target2: 100000, totalQty: 1, remainingQty: 1, side: -1, pointValue: 10, symbol: 'GOLDM' });
  checkAndCloseIfHit(s2, 118450, fcfg, 1); // profit 15,500 → 10,000 secured → stop 120000 − 1000 = 119000
  assert.deepEqual([s2.position!.lockedPnl, s2.position!.currentSl], [10000, 119000]);
});

test('profit lock off: unchanged workbook behaviour (T2 closes the rest)', () => {
  const s = stateWith(pos());
  const off = { ...cfg, profitLock: false, dayPlanLock: false };
  checkAndCloseIfHit(s, 105, off, 1);
  checkAndCloseIfHit(s, 125, off, 2);
  assert.equal(s.position, null);
  assert.match(s.journal[0].exitReason, /^TARGET 2 HIT/);
});

let fake: Awaited<ReturnType<typeof startFakeDhan>>;
before(async () => {
  fake = await startFakeDhan();
});
after(() => fake.server.close());

test('LIVE: a raised lock replaces the exchange stop at the new level', async () => {
  const dhan = new DhanClient({ clientId: FAKE_CLIENT, accessToken: FAKE_TOKEN, baseUrl: fake.url });
  const trader = new LiveTrader(dhan, new DhanService(dhan, { liveOrders: true, maxOrderValue: 0 }), { sleep: async () => {} });
  const runner = new EngineRunner({ load: async () => { throw new Error('unused'); } }, { load: async () => null, save: async () => {} });
  const sl = await dhan.placeOrder({ securityId: '70483', exchangeSegment: 'NSE_FNO', transactionType: 'SELL', quantity: 500, orderType: 'STOP_LOSS', productType: 'INTRADAY', price: 95, triggerPrice: 100 });
  const half = { ...pos(), partialBooked: true, partialQty: 500, partialPnl: 2500, remainingQty: 500, currentSl: 100, live: { securityId: '70483', entryOrderId: 'E1', slOrderId: String(sl.orderId) } };
  const beforeS = { ...stateWith(half) };
  const afterS = { ...stateWith({ ...half, currentSl: 115, lockedPnl: 10000, peakPnl: 15000, lockPrice: 115 }) };
  runner.state = afterS;
  setHolding(fake.state, '70483', 500); // the account holds the 500 still open
  const sent = () => fake.requests.filter((r) => r.method === 'POST' && r.path === '/orders').map((r) => r.body);
  const n = sent().length;
  await trader.afterCycle(runner, beforeS, afterS);
  assert.equal(fake.state.orders.find((o: any) => o.orderId === String(sl.orderId)).orderStatus, 'CANCELLED');
  const [stop] = sent().slice(n);
  assert.deepEqual([stop.transactionType, stop.orderType, stop.quantity, stop.triggerPrice], ['SELL', 'STOP_LOSS', 500, 115]);
  assert.notEqual(runner.state.position!.live!.slOrderId, String(sl.orderId));
});
