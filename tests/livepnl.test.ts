/// <reference types="node" />
/** Running P&L: positionPnl, the runner's livePnl, and the phone's fast quote ticker (fake Dhan). */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createLocalApi, type LocalApi } from '../src/api/localApi.ts';
import { EngineRunner, positionPnl } from '../src/lib/engine/runner.ts';
import type { OpenPosition } from '../src/lib/engine/types.ts';
import { FAKE_CLIENT, FAKE_TOKEN, GOLDEN_EXPIRY, startFakeDhan } from './fakeDhan.ts';

const pos = (over: Partial<OpenPosition> = {}): OpenPosition => ({
  direction: 'CE', strike: 24000, entry: 100, originalSl: 90, target1: 120, target2: 130, totalQty: 130,
  journalId: 'J1', openedAt: 0, partialBooked: false, partialQty: 0, partialPnl: 0, remainingQty: 130,
  currentSl: 90, ...over,
});

test('positionPnl: open part, booked half, shorts and ₹ per point', () => {
  assert.deepEqual(positionPnl(pos(), 110), { open: 1300, trade: 1300 });
  assert.deepEqual(positionPnl(pos({ partialBooked: true, partialQty: 65, remainingQty: 65, partialPnl: 1300 }), 110), {
    open: 650,
    trade: 1950,
  });
  assert.deepEqual(positionPnl(pos({ side: -1, pointValue: 10, entry: 120000, totalQty: 1, remainingQty: 1 }), 119900), {
    open: 1000,
    trade: 1000,
  });
});

test('runner livePnl: no position → realized only; a fresh tick beats the refresh price; old ticks ignored', () => {
  const r = new EngineRunner({ load: async () => ({}) as never }, { load: async () => null, save: async () => {} });
  r.state = { ...r.state, realizedToday: 500 };
  assert.deepEqual([r.livePnl().dayPnl, r.livePnl().tradePnl], [500, null]);
  r.state = { ...r.state, position: pos() };
  r.lastRefresh = 1000;
  r.dashboard = { positionLtp: 105 } as never;
  let l = r.livePnl();
  assert.deepEqual([l.ltp, l.source, l.tradePnl, l.dayPnl, l.invested], [105, 'REFRESH', 650, 1150, 13000]);
  r.setMark(112, 2000);
  l = r.livePnl();
  assert.deepEqual([l.ltp, l.source, l.tradePnl, l.dayPnl], [112, 'TICK', 1560, 2060]);
  r.lastRefresh = 3000; // a newer refresh wins over the older tick
  assert.equal(r.livePnl().source, 'REFRESH');
  r.setMark(50, 4000, 'some-other-position'); // quotes for another position are dropped
  assert.equal(r.livePnl().ltp, 105);
});

let fake: Awaited<ReturnType<typeof startFakeDhan>>;
let api: LocalApi;
before(async () => {
  fake = await startFakeDhan();
  api = await createLocalApi({
    clientId: FAKE_CLIENT,
    accessToken: FAKE_TOKEN,
    baseUrl: fake.url,
    store: { load: async () => null, save: async () => {} },
    staticIp: () => '',
    publicIp: async () => '198.51.100.20',
    sleep: async () => {},
    positionTickMs: 30,
    tickAlways: true,
  });
  await api.engineConfig({ expiry: GOLDEN_EXPIRY });
  await api.engineRefresh();
});
after(() => {
  api.dispose();
  fake.server.close();
});

test('phone: the open position is quoted between refreshes and the P&L runs', async () => {
  let s = await api.engineEnter();
  const p = s.state.position!;
  assert.ok(p);
  // find the security the ticker quotes and move its price up by 10
  const quoted = () =>
    fake.requests.filter((r) => r.method === 'POST' && r.path === '/marketfeed/quote' && r.body?.NSE_FNO);
  for (let i = 0; i < 400 && !quoted().length; i++) await new Promise((r) => setTimeout(r, 25));
  const id = String(quoted().at(-1)!.body.NSE_FNO[0]);
  fake.state.ltp.set(`NSE_FNO|${id}`, p.entry + 10);
  for (let i = 0; i < 200; i++) {
    s = await api.engine();
    if (s.live.ltp === p.entry + 10) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(s.live.source, 'TICK');
  assert.equal(s.live.ltp, p.entry + 10);
  assert.ok(Math.abs(s.live.tradePnl! - 10 * p.totalQty) < 1e-6);
  assert.ok(Math.abs(s.live.dayPnl - (s.live.realizedToday + 10 * p.totalQty)) < 1e-6);
  s = await api.engineExit();
  assert.equal(s.live.tradePnl, null);
});
