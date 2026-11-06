/// <reference types="node" />
/** Entry mode: PAPER manual/automatic, LIVE automatic (one order per confirmed signal, through ENTER's path). */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { DhanClient } from '../server/dhan.ts';
import { DhanEngineSource } from '../server/engineSource.ts';
import { LiveTrader } from '../server/liveTrader.ts';
import { DhanService } from '../server/service.ts';
import { runCycle } from '../src/lib/engine/decision.ts';
import { EngineRunner, sanitizeConfig } from '../src/lib/engine/runner.ts';
import { DEFAULT_CONFIG, initialEngineState, type Candle, type ChainSnapshot, type EngineConfig } from '../src/lib/engine/types.ts';
import { FAKE_CLIENT, FAKE_TOKEN, GOLDEN_EXPIRY, startFakeDhan } from './fakeDhan.ts';

/** The workbook's rule: enter on the first break after the trade level (no hold). */
const WB_CONFIG = { ...DEFAULT_CONFIG, confirmHoldMinutes: 0, dayPlanLock: false };

const fx = JSON.parse(readFileSync(new URL('./fixtures/workbook-2026-08-27.json', import.meta.url), 'utf8'));
const candles: Candle[] = fx.candles;
const chain: ChainSnapshot = fx.chain;
const now0 = Date.UTC(2026, 7, 27, 6, 10, 27); // 11:40 IST

/** Arm, then break the trigger: returns the cycle that confirms the signal (and the next one). */
function confirm(cfg: EngineConfig) {
  let r = runCycle({ ...initialEngineState(), ivHistory: fx.ivHistoryBefore }, cfg, { candles, chain, now: now0 });
  const trig = r.state.pending!.trigger;
  const last = candles[candles.length - 1];
  const broke = [...candles.slice(0, -1), { ...last, l: trig - 1 }];
  r = runCycle(r.state, cfg, { candles: broke, chain, now: now0 + 30_000 });
  const next = runCycle(r.state, cfg, { candles: broke, chain, now: now0 + 45_000 });
  return { r, next };
}

test('defaults: PAPER automatic (as before), LIVE manual; switching into LIVE turns automatic off', () => {
  assert.deepEqual([WB_CONFIG.autoEntryPaper, WB_CONFIG.autoEntryLive], [true, false]);
  const armed = sanitizeConfig({ autoEntryLive: true }, WB_CONFIG);
  assert.equal(armed.autoEntryLive, true);
  assert.equal(sanitizeConfig({ tradeMode: 'LIVE' }, armed).autoEntryLive, false);
  const live = { ...armed, tradeMode: 'LIVE' as const };
  assert.equal(sanitizeConfig({ autoEntryLive: true }, live).autoEntryLive, true); // turned on while LIVE: kept
  assert.equal(sanitizeConfig({ confHigh: 81 }, { ...live, autoEntryLive: true }).autoEntryLive, true);
});

test('PAPER manual: a confirmed signal waits for ENTER (alerts once)', () => {
  const { r, next } = confirm({ ...WB_CONFIG, autoEntryPaper: false });
  assert.equal(r.state.position, null);
  assert.match(r.dashboard.decision.decisionText, /^SIGNAL CONFIRMED - tap ENTER to trade \(/);
  assert.equal(r.state.events[0].kind, 'SIGNAL');
  assert.equal(r.state.liveAutoRequest, null);
  assert.equal(next.state.events.filter((e) => e.kind === 'SIGNAL').length, 1);
});

test('PAPER automatic: unchanged, the signal is traded on paper', () => {
  const { r } = confirm(WB_CONFIG);
  assert.ok(r.state.position);
  assert.equal(r.state.liveAutoRequest, null);
});

test('LIVE manual: no order request; LIVE automatic: one request for the cycle that confirmed', () => {
  const manual = confirm({ ...WB_CONFIG, tradeMode: 'LIVE' });
  assert.equal(manual.r.state.liveAutoRequest, null);
  assert.match(manual.r.dashboard.decision.decisionText, /tap ENTER to trade live/);
  const auto = confirm({ ...WB_CONFIG, tradeMode: 'LIVE', autoEntryLive: true });
  assert.equal(auto.r.state.position, null); // the engine never fakes a live position
  assert.match(auto.r.state.liveAutoRequest!, /^2026-08-27\|PE\|/);
  assert.match(auto.r.dashboard.decision.decisionText, /placing the LIVE order automatically/);
  assert.match(auto.r.state.events[0].message, /placing LIVE order automatically$/);
  assert.equal(auto.next.state.liveAutoRequest, null); // same signal next cycle: no second order
});

let fake: Awaited<ReturnType<typeof startFakeDhan>>;
before(async () => {
  fake = await startFakeDhan();
});
after(() => fake.server.close());

async function liveRunner(over: Partial<EngineConfig>) {
  const dhan = new DhanClient({ clientId: FAKE_CLIENT, accessToken: FAKE_TOKEN, baseUrl: fake.url });
  const trader = new LiveTrader(dhan, new DhanService(dhan, { liveOrders: true, maxOrderValue: 0 }), { sleep: async () => {} });
  const runner = new EngineRunner(new DhanEngineSource(dhan), { load: async () => null, save: async () => {} });
  await runner.init();
  // tests run at any hour: no entry cutoff
  await runner.updateConfig({ expiry: GOLDEN_EXPIRY, lastEntryTime: '', tradeMode: 'LIVE', ...over });
  await runner.refresh();
  return { runner, trader };
}
const ordersSent = () => fake.requests.filter((r) => r.method === 'POST' && r.path === '/orders').map((r) => r.body);

test('LIVE automatic: the request places a market BUY + exchange stop, journaled as Auto LIVE entry', async () => {
  const { runner, trader } = await liveRunner({ autoEntryLive: true });
  const n = ordersSent().length;
  runner.state = { ...runner.state, liveAutoRequest: 'test-key' };
  await trader.afterCycle(runner, runner.state, runner.state);
  const [buy, stop] = ordersSent().slice(n);
  assert.deepEqual([buy.transactionType, buy.orderType], ['BUY', 'MARKET']);
  assert.deepEqual([stop.transactionType, stop.orderType], ['SELL', 'STOP_LOSS']);
  assert.ok(runner.state.position?.live?.slOrderId);
  assert.match(runner.state.journal.at(-1)!.entryReason, /^Auto LIVE entry/);
  assert.match(runner.status, /^Automatic LIVE entry filled/);
  assert.equal(runner.state.liveAutoRequest, null);
});

test('LIVE automatic respects the gates; switched off → nothing is sent', async () => {
  // Past the entry cutoff: refused, reported as an order error (alerts), nothing sent.
  const { runner, trader } = await liveRunner({ autoEntryLive: true, lastEntryTime: '00:01' });
  let n = ordersSent().length;
  runner.state = { ...runner.state, liveAutoRequest: 'k1' };
  await trader.afterCycle(runner, runner.state, runner.state);
  assert.equal(ordersSent().length, n);
  assert.match(runner.status, /^Live order error - automatic entry failed: No new trades after 00:01 IST/);
  // Manual mode: a stray request is ignored.
  const m = await liveRunner({ autoEntryLive: false });
  n = ordersSent().length;
  m.runner.state = { ...m.runner.state, liveAutoRequest: 'k2' };
  await m.trader.afterCycle(m.runner, m.runner.state, m.runner.state);
  assert.equal(ordersSent().length, n);
  assert.equal(m.runner.state.position, null);
});
