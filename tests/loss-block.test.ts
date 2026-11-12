/// <reference types="node" />
/** "Clear block": lift today's no-revenge-trade block (e.g. a loss from a wrongly set limit). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canTakeNewTrade, lossesToday, todayHasLoggedLoss } from '../src/lib/engine/decision.ts';
import { EngineRunner } from '../src/lib/engine/runner.ts';
import { DEFAULT_CONFIG, initialEngineState, type EngineState, type JournalRow } from '../src/lib/engine/types.ts';

const day = '2026-11-12';
const row = (id: string, pnl: number | null, date = day): JournalRow =>
  ({ id, date, time: '10:00:00', spot: 0, strike: 24300, direction: 'CE', entry: 100, sl: 90, target: 120, exit: pnl == null ? null : 100, pnl, confidence: 85, trend: '', pcr: 1, oiBias: '', iv: 12, delta: 0.5, entryReason: '', exitReason: '' }) as JournalRow;
const cfg = { ...DEFAULT_CONFIG, maxTradesPerDay: 10, maxDailyLoss: 0, lastEntryTime: '' };
const now = Date.parse(`${day}T11:00:00+05:30`);

function runnerWith(journal: JournalRow[], extra: Partial<EngineState> = {}) {
  let saved: any = null;
  const store = { load: async () => saved, save: async (state: any, config: any) => void (saved = JSON.parse(JSON.stringify({ state, config }))) };
  const r = new EngineRunner({ load: async () => { throw new Error('offline'); }, now: () => now }, store);
  r.config = cfg;
  r.state = { ...initialEngineState(), day, journal, realizedToday: journal.reduce((s, j) => s + (j.pnl ?? 0), 0), blockedReason: 'No-revenge-trade rule: a loss was logged today', ...extra };
  return { r, store, saved: () => saved };
}

test('a loss today blocks; Clear block allows trading again; the block reason is cleared; an event is logged', async () => {
  const { r } = runnerWith([row('J1', -4500)]);
  assert.equal(canTakeNewTrade(r.state, cfg, now).ok, false);
  assert.deepEqual(r.snapshot().lossBlock, { losses: 1 });
  await r.clearLossBlock();
  assert.deepEqual(canTakeNewTrade(r.state, cfg, now), { ok: true, reason: '' });
  assert.equal(r.snapshot().lossBlock, undefined);
  assert.equal(r.state.blockedReason, '');
  assert.match(r.state.events[0].message, /block cleared by you \(1 loss today\)/);
});

test('a new loss after the clear blocks again; clearing again covers it', async () => {
  const { r } = runnerWith([row('J1', -4500)]);
  await r.clearLossBlock();
  r.state = { ...r.state, journal: [...r.state.journal, row('J2', 2000), row('J3', -1500)] };
  assert.equal(todayHasLoggedLoss(r.state), true);
  assert.equal(lossesToday(r.state), 2);
  await r.clearLossBlock();
  assert.equal(todayHasLoggedLoss(r.state), false);
});

test('only the no-revenge rule is lifted: the daily max loss and the trade limit still block', async () => {
  const { r } = runnerWith([row('J1', -4500)]);
  await r.clearLossBlock();
  assert.match(canTakeNewTrade(r.state, { ...cfg, maxDailyLoss: 3000 }, now).reason, /Daily max loss/);
  assert.match(canTakeNewTrade({ ...r.state, tradesToday: 3 }, { ...cfg, maxTradesPerDay: 3 }, now).reason, /Daily trade limit/);
});

test('nothing to clear: no loss, or already cleared → a clear message; a profit day is never blocked', async () => {
  await assert.rejects(runnerWith([row('J1', 3000)]).r.clearLossBlock(), /No loss logged today/);
  const { r } = runnerWith([row('J1', -100)]);
  await r.clearLossBlock();
  await assert.rejects(r.clearLossBlock(), /already cleared/);
});

test('the clear is for its own day: a stale marker never unblocks a later day', () => {
  const s = { day, journal: [row('J1', -100)], lossBlockCleared: { day: '2026-11-11', losses: 5 } };
  assert.equal(todayHasLoggedLoss(s), true);
});

test('the clear is saved: it survives a restart', async () => {
  const { r, store } = runnerWith([row('J1', -4500)]);
  await r.clearLossBlock();
  const r2 = new EngineRunner({ load: async () => { throw new Error('offline'); }, now: () => now }, store);
  await r2.init();
  assert.deepEqual(r2.state.lossBlockCleared, { day, losses: 1 });
  assert.equal(r2.lossBlocked(), false);
});
