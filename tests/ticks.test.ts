/// <reference types="node" />
/** Fast ticks: Dhan quotes every second between full refreshes — breaks, stops and P&L act on them. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EngineRunner } from '../src/lib/engine/runner.ts';
import { applyTick, tickCandles, tickRequests, type QuoteMap, type QuoteReq } from '../src/lib/engine/ticks.ts';
import { DEFAULT_CONFIG, type Candle, type ChainSnapshot, type EngineConfig } from '../src/lib/engine/types.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/workbook-2026-08-27.json', import.meta.url), 'utf8'));
const t0 = Date.UTC(2026, 7, 27, 6, 10, 0); // 11:40 IST
const legId = (strike: number, side: string) => `${side}${strike}`;

/** The fixture market, with a Dhan security id on every option leg. */
function market(k = 1, step = 50) {
  const candles: Candle[] = fx.candles.map((c: Candle) => ({ ...c, o: c.o * k, h: c.h * k, l: c.l * k, c: c.c * k }));
  const strikes = fx.chain.strikes.map((s: any) => {
    const strike = Math.round((s.strike * k) / step) * step;
    const leg = (l: any, side: string) => l && { ...l, ltp: l.ltp * k, securityId: legId(strike, side) };
    return { strike, ce: leg(s.ce, 'CE'), pe: leg(s.pe, 'PE') };
  });
  return { candles, chain: { ...fx.chain, spot: fx.chain.spot * k, strikes } as ChainSnapshot };
}

function setup(over: Partial<EngineConfig> = {}) {
  let now = t0;
  const asked: QuoteReq[][] = [];
  const prices: QuoteMap = {};
  let loads = 0;
  const source = {
    load: async (cfg: EngineConfig) => {
      loads++;
      return cfg.symbol === 'BANKNIFTY' ? market(2.23, 100) : market();
    },
    now: () => now,
  };
  const r = new EngineRunner(source as never, { load: async () => null, save: async () => {} });
  r.quoteSource = async (reqs) => {
    asked.push(reqs);
    const out: QuoteMap = {};
    for (const q of reqs) if (prices[`${q.segment}|${q.securityId}`]) out[`${q.segment}|${q.securityId}`] = prices[`${q.segment}|${q.securityId}`];
    return out;
  };
  const ready = (async () => {
    await r.init();
    await r.updateConfig({ lastEntryTime: '', dayPlanLock: false, lossTrail: false, confirmHoldSeconds: 0, ...over });
  })();
  return { r, asked, prices, ready, loads: () => loads, at: (ms: number) => (now = t0 + ms) };
}

test('the forming candle takes the tick; a new 5 minutes starts a new candle', () => {
  const c: Candle[] = [{ t: t0, o: 100, h: 105, l: 99, c: 101, v: 7 }];
  assert.deepEqual(tickCandles(c, 98, t0 + 60_000).at(-1), { t: t0, o: 100, h: 105, l: 98, c: 98, v: 7 });
  assert.deepEqual(tickCandles(c, 106, t0 + 60_000).at(-1)!.h, 106);
  const next = tickCandles(c, 102, t0 + 5 * 60_000 + 1000);
  assert.equal(next.length, 2);
  assert.deepEqual(next[1], { t: t0 + 5 * 60_000, o: 102, h: 102, l: 102, c: 102, v: 0 });
});

test('what is quoted: spot + ATM ± 1 (both sides) + the trade / setup legs, once each', () => {
  const d = market();
  const reqs = tickRequests(DEFAULT_CONFIG, d, { position: null, pending: { direction: 'PE', strike: 24000, trigger: 1, setAt: 0 }, pendingEntry: null });
  assert.deepEqual(reqs[0], { segment: 'IDX_I', securityId: '13' });
  assert.ok(reqs.some((q) => q.securityId === 'PE24000'));
  assert.equal(new Set(reqs.map((q) => q.securityId)).size, reqs.length);
  assert.ok(reqs.length <= 9);
  const patched = applyTick(DEFAULT_CONFIG, d, {}, { 'IDX_I|13': 24111.5 }, t0);
  assert.equal(patched.chain.spot, 24111.5);
  assert.equal(patched.candles.at(-1)!.c, 24111.5);
  assert.equal(d.chain.spot, fx.chain.spot); // the input isn't changed
});

test('a setup break is seen on a tick — no full refresh needed', async () => {
  const { r, prices, ready, at, loads } = setup();
  await ready;
  await r.refresh(); // arms the setup
  const pend = r.state.pending!;
  assert.ok(pend, 'armed');
  const full = loads();
  const lastRefresh = r.lastRefresh;
  at(20_000);
  prices['IDX_I|13'] = pend.direction === 'PE' ? pend.trigger - 5 : pend.trigger + 5;
  await r.tick();
  assert.ok(r.state.position, r.dashboard?.decision.decisionText);
  assert.equal(loads(), full); // no candles / chain reload
  assert.equal(r.lastRefresh, lastRefresh); // the next full refresh stays on schedule
  assert.equal(r.lastTick, t0 + 20_000);
});

test('the open trade is priced and stopped on ticks; the live P&L shows the tick', async () => {
  const { r, prices, ready, at } = setup();
  await ready;
  await r.refresh();
  const pend = r.state.pending!;
  at(10_000);
  prices['IDX_I|13'] = pend.direction === 'PE' ? pend.trigger - 5 : pend.trigger + 5;
  await r.tick();
  const p = r.state.position!;
  const id = `NSE_FNO|${legId(p.strike, p.direction)}`;
  at(12_000);
  prices[id] = p.entry + 1;
  await r.tick();
  assert.equal(r.livePnl().source, 'TICK');
  assert.equal(r.livePnl().ltp, p.entry + 1);
  at(14_000);
  prices[id] = Math.max(0.05, p.currentSl - 1);
  await r.tick();
  assert.equal(r.state.position, null);
  assert.match(r.state.journal[0].exitReason, /SL HIT/);
});

test('off, or before the first full refresh: no ticks', async () => {
  const a = setup({ fastTicks: false });
  await a.ready;
  await a.r.refresh();
  assert.equal(a.r.canTick(), false);
  const c = setup();
  await c.ready;
  await c.r.refresh();
  assert.equal(c.r.canTick(), true);
  c.at(61_000); // full refreshes failing for a minute: no ticks on the old chain
  assert.equal(c.r.canTick(), false);
  const b = setup();
  await b.ready;
  assert.equal(b.r.canTick(), false); // nothing loaded yet
  await b.r.tick();
  assert.equal(b.asked.length, 0);
});

test('multi-index: one quote call covers both indexes', async () => {
  const { r, asked, prices, ready, at } = setup({ multiIndex: true });
  await ready;
  await r.refresh();
  at(5_000);
  prices['IDX_I|13'] = fx.chain.spot + 1;
  prices['IDX_I|25'] = fx.chain.spot * 2.23 + 1;
  await r.tick();
  assert.equal(asked.length, 1);
  assert.ok(asked[0].some((q) => q.securityId === '13') && asked[0].some((q) => q.securityId === '25'));
  assert.equal(r.multiDash.BANKNIFTY.market.spot, fx.chain.spot * 2.23 + 1);
  assert.equal(r.multiDash.NIFTY.market.spot, fx.chain.spot + 1);
});

test('phone: ticks go to Dhan as one /marketfeed/quote with the index and option ids', async () => {
  const { createLocalApi } = await import('../src/api/localApi.ts');
  const { FAKE_CLIENT, FAKE_TOKEN, GOLDEN_EXPIRY, startFakeDhan } = await import('./fakeDhan.ts');
  const fake = await startFakeDhan();
  const api = await createLocalApi({
    positionTickMs: 0,
    clientId: FAKE_CLIENT,
    accessToken: FAKE_TOKEN,
    baseUrl: fake.url,
    store: { load: async () => null, save: async () => {} },
    staticIp: () => '',
    publicIp: async () => '198.51.100.20',
    sleep: async () => {},
  });
  try {
    await api.engineConfig({ expiry: GOLDEN_EXPIRY, lastEntryTime: '' });
    await api.engineRefresh();
    const engine = api.runner;
    assert.equal(engine.canTick(), true);
    const n = fake.requests.length;
    await engine.tick();
    const q = fake.requests.slice(n).filter((x) => x.path === '/marketfeed/quote');
    assert.equal(q.length, 1);
    assert.deepEqual(q[0].body.IDX_I, [13]);
    assert.ok(q[0].body.NSE_FNO.length >= 6);
    assert.ok(engine.lastTick != null);
  } finally {
    api.dispose();
    fake.server.close();
  }
});
