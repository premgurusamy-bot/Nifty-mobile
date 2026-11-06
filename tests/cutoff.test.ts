/// <reference types="node" />
/** Entry cutoff: no new trades after the set IST time (default 14:35 for NSE, none for MCX). */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { canTakeNewTrade, pastEntryCutoff, runCycle } from '../src/lib/engine/decision.ts';
import { EngineRunner, sanitizeConfig } from '../src/lib/engine/runner.ts';
import { DEFAULT_CONFIG, initialEngineState, type Candle, type ChainSnapshot } from '../src/lib/engine/types.ts';

/** The workbook's rule: enter on the first break after the trade level (no hold). */
const WB_CONFIG = { ...DEFAULT_CONFIG, confirmHoldMinutes: 0 };

const fx = JSON.parse(readFileSync(new URL('./fixtures/workbook-2026-08-27.json', import.meta.url), 'utf8'));
const candles: Candle[] = fx.candles;
const chain: ChainSnapshot = fx.chain;
const ist = (hh: number, mm: number, ss = 0) => Date.UTC(2026, 7, 27, hh, mm, ss) - 5.5 * 3600_000;

test('default is 14:35 IST for NSE; MCX has no cutoff; the setting is validated', () => {
  assert.equal(WB_CONFIG.lastEntryTime, '14:35');
  assert.equal(WB_CONFIG.lastEntryTimeMcx, '');
  assert.equal(sanitizeConfig({ lastEntryTime: '9:05' }, WB_CONFIG).lastEntryTime, '09:05');
  assert.equal(sanitizeConfig({ lastEntryTime: ' ' }, WB_CONFIG).lastEntryTime, '');
  assert.throws(() => sanitizeConfig({ lastEntryTime: '25:00' }, WB_CONFIG), /HH:MM/);
  assert.throws(() => sanitizeConfig({ lastEntryTime: '2.35pm' }, WB_CONFIG), /HH:MM/);
  const gold = sanitizeConfig({ symbol: 'GOLDM' }, WB_CONFIG);
  assert.equal(pastEntryCutoff(gold, ist(20, 0)), false); // MCX keeps trading in the evening
  assert.equal(pastEntryCutoff({ ...gold, lastEntryTimeMcx: '22:00' }, ist(22, 0)), true);
});

test('the gate opens until 14:34:59 and closes from 14:35', () => {
  const s = initialEngineState();
  assert.equal(canTakeNewTrade(s, WB_CONFIG, ist(14, 34, 59)).ok, true);
  const g = canTakeNewTrade(s, WB_CONFIG, ist(14, 35));
  assert.deepEqual(g, { ok: false, reason: 'No new trades after 14:35 IST' });
  assert.equal(canTakeNewTrade(s, { ...WB_CONFIG, lastEntryTime: '' }, ist(15, 20)).ok, true);
});

test('after the cutoff a confirmed setup does not trade and armed setups are dropped', () => {
  const st = { ...initialEngineState(), ivHistory: fx.ivHistoryBefore };
  // Arms before the cutoff …
  let r = runCycle(st, WB_CONFIG, { candles, chain, now: ist(14, 34) });
  assert.match(r.dashboard.decision.decisionText, /^SETUP ARMED/);
  const trig = r.state.pending!.trigger;
  const last = candles[candles.length - 1];
  const broke = [...candles.slice(0, -1), { ...last, l: trig - 1 }];
  // … the break comes at 14:36 → blocked, nothing opened, setup cleared.
  r = runCycle(r.state, WB_CONFIG, { candles: broke, chain, now: ist(14, 36) });
  assert.equal(r.state.position, null);
  assert.equal(r.state.tradesToday, 0);
  assert.equal(r.state.pending, null);
  assert.equal(r.dashboard.decision.decisionText, 'BLOCKED - No new trades after 14:35 IST');
  // Same break before the cutoff trades as usual.
  const early = runCycle(runCycle(st, WB_CONFIG, { candles, chain, now: ist(14, 0) }).state, WB_CONFIG, {
    candles: broke,
    chain,
    now: ist(14, 1),
  });
  assert.ok(early.state.position);
});

test('manual ENTER is refused after the cutoff; an open trade is still managed', async () => {
  let now = ist(14, 40);
  const r = new EngineRunner(
    { load: async () => ({ candles, chain }), now: () => now },
    { load: async () => null, save: async () => {} },
  );
  await r.init();
  await r.refresh();
  assert.throws(() => r.entryPlan(), /No new trades after 14:35 IST/);
  now = ist(11, 0);
  await r.refresh();
  await r.manualEnter();
  assert.ok(r.state.position);
  now = ist(14, 50); // past the cutoff: exit still works
  await r.refresh();
  await r.manualExit({});
  assert.equal(r.state.position, null);
});
