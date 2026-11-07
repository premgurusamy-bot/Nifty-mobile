/// <reference types="node" />
/** Loss trail: best profit 5,000 → may lose 15,000 at most; 8,500 → 7,000; tighter-only; then the profit lock. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { categoryOf } from '../src/lib/alerts.ts';
import { checkAndCloseIfHit, openTrade } from '../src/lib/engine/decision.ts';
import { lossCapFor } from '../src/lib/engine/profitLock.ts';
import { sanitizeConfig } from '../src/lib/engine/runner.ts';
import { DEFAULT_CONFIG, initialEngineState, type EngineConfig, type EngineState, type TradePlan } from '../src/lib/engine/types.ts';

const cfg: EngineConfig = { ...DEFAULT_CONFIG, lotSize: 100, maxLots: 0 };
const T = Date.UTC(2026, 10, 6, 5, 0); // 10:30 IST

/** Long option, entry 100, 1000 qty (₹1,000 per point); stop `sl` (100−sl points × 1000 = max loss). */
function trade(sl: number, c: EngineConfig = cfg) {
  const s: EngineState = initialEngineState();
  s.day = '2026-11-06';
  const plan: TradePlan = { strike: 24000, direction: 'CE', entry: 100, sl, target1: 140, target2: 160, riskPts: 100 - sl, rewardPts: 40, rr: '', qty: 1000, maxLoss: (100 - sl) * 1000, potentialProfit: 40000 };
  openTrade(s, c, { direction: 'CE', plan, entry: 100, qty: 1000, now: T, spot: 24000, confidence: 85, trend: '', pcr: 1, oiBias: '', iv: 11, delta: 0.5, reason: 'x' });
  return s;
}

test('defaults and validation', () => {
  assert.deepEqual([cfg.lossTrail, cfg.lt1At, cfg.lt1Loss, cfg.lt2At, cfg.lt2Loss], [true, 5000, 15000, 8500, 7000]);
  assert.throws(() => sanitizeConfig({ lt2At: 4000 }, DEFAULT_CONFIG), /step 2 profit must be above step 1/);
  assert.throws(() => sanitizeConfig({ lt2Loss: 16000 }, DEFAULT_CONFIG), /must not grow/);
  assert.equal(sanitizeConfig({ lossTrail: false }, DEFAULT_CONFIG).lossTrail, false);
});

test('steps: below 5k none, 5k → 15k, 8.5k → 7k', () => {
  assert.deepEqual([0, 4999, 5000, 8499, 8500, 8950, 20000].map((p) => lossCapFor(p, cfg)), [null, null, 15000, 15000, 7000, 7000, 7000]);
  assert.equal(lossCapFor(9000, { ...cfg, lossTrail: false }), null);
});

test('a ₹20,000-stop trade: 20k → 15k → 7k → profit lock; falling back exits as LOSS TRAIL', () => {
  const s = trade(80); // may lose 20k
  checkAndCloseIfHit(s, 104, cfg, T + 1); // +4k: nothing yet
  assert.equal(s.position!.currentSl, 80);
  checkAndCloseIfHit(s, 105, cfg, T + 2); // +5k → may lose 15k → stop 85
  assert.deepEqual([s.position!.lossCap, s.position!.currentSl], [15000, 85]);
  assert.match(s.events[0].message, /loss trail: best profit Rs 5000, may now lose Rs 15000 at most, stop 85\.00/);
  assert.equal(categoryOf(s.events[0]), 'lock');
  checkAndCloseIfHit(s, 102, cfg, T + 3); // dips: the stop never goes back
  assert.equal(s.position!.currentSl, 85);
  checkAndCloseIfHit(s, 108.6, cfg, T + 4); // +8.6k → may lose 7k → stop 93
  assert.deepEqual([s.position!.lossCap, s.position!.currentSl], [7000, 93]);
  checkAndCloseIfHit(s, 92.9, cfg, T + 5); // falls through 93
  assert.equal(s.position, null);
  assert.equal(s.journal[0].pnl, -7000);
  assert.match(s.journal[0].exitReason, /^LOSS TRAIL HIT \(loss kept to Rs 7000 at most\)/);
});

test('then the day plan takes over: 9k → 5k secured', () => {
  const s = trade(80);
  checkAndCloseIfHit(s, 108.6, cfg, T + 1);
  checkAndCloseIfHit(s, 109.1, cfg, T + 2);
  assert.deepEqual([s.position!.lockedPnl, s.position!.currentSl], [5000, 105]);
  checkAndCloseIfHit(s, 104.9, cfg, T + 3);
  assert.match(s.journal[0].exitReason, /^PROFIT LOCK HIT \(Rs 5000 secured\)/);
});

test('a small stop is kept when it is already tighter (₹4,000 max loss)', () => {
  const s = trade(96);
  checkAndCloseIfHit(s, 105, cfg, T + 1);
  checkAndCloseIfHit(s, 108.6, cfg, T + 2);
  assert.equal(s.position!.currentSl, 96); // 15k / 7k caps would be looser
  assert.equal(s.events.filter((e) => /loss trail/.test(e.message)).length, 0);
  checkAndCloseIfHit(s, 95.9, cfg, T + 3);
  assert.match(s.journal[0].exitReason, /^SL HIT/);
});

test('off: the stop stays where it was', () => {
  const off = { ...cfg, lossTrail: false };
  const s = trade(80, off);
  checkAndCloseIfHit(s, 108.6, off, T + 1);
  assert.equal(s.position!.currentSl, 80);
});
