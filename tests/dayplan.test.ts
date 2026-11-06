/// <reference types="node" />
/** Day plan lock: trade 1 ladder (9k→5k, 12k→7k, 14k→10k, then trailing), trade 2 day floor, others the profit lock. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { categoryOf } from '../src/lib/alerts.ts';
import { checkAndCloseIfHit, openTrade } from '../src/lib/engine/decision.ts';
import { dayPlanFor, firstTradeLock, lockFor } from '../src/lib/engine/profitLock.ts';
import { sanitizeConfig } from '../src/lib/engine/runner.ts';
import { DEFAULT_CONFIG, initialEngineState, type EngineState, type TradePlan } from '../src/lib/engine/types.ts';

const cfg = { ...DEFAULT_CONFIG, lotSize: 100, maxLots: 0 };

test('defaults and validation', () => {
  assert.deepEqual(
    [cfg.dayPlanLock, cfg.dl1At, cfg.dl1Lock, cfg.dl2At, cfg.dl2Lock, cfg.dl3At, cfg.dl3Lock, cfg.dayFloor],
    [true, 9000, 5000, 12000, 7000, 14000, 10000, 10000],
  );
  assert.throws(() => sanitizeConfig({ dl2At: 8000 }, DEFAULT_CONFIG), /steps must rise/);
  assert.throws(() => sanitizeConfig({ dl2Lock: 4000 }, DEFAULT_CONFIG), /must not fall/);
  assert.throws(() => sanitizeConfig({ dl1Lock: 9500, dl2Lock: 9600 }, DEFAULT_CONFIG), /below its best-profit step/);
});

test('trade 1 ladder: 9k→5k, 12k→7k, 14k→10k, then the profit lock trails (never below 10k)', () => {
  const at = (p: number) => firstTradeLock(p, cfg);
  assert.deepEqual(
    [8999, 9000, 10500, 11999, 12000, 13999, 14000, 19000, 20000, 25000, 30000, 42000].map(at),
    [null, 5000, 5000, 5000, 7000, 7000, 10000, 10000, 15000, 20000, 20000, 32000],
  );
});

test('which rule a trade follows', () => {
  assert.equal(dayPlanFor(0, 0, cfg), 'FIRST');
  assert.equal(dayPlanFor(1, 14000, cfg), 'SECOND'); // trade 1 booked ≥ 10k
  assert.equal(dayPlanFor(1, 9999, cfg), 'NORMAL');
  assert.equal(dayPlanFor(2, 30000, cfg), 'NORMAL');
  assert.equal(dayPlanFor(0, 0, { ...cfg, dayPlanLock: false }), undefined);
});

test('trade 2: stop keeps the day ≥ 10k, then the profit lock on top', () => {
  const p = { dayPlan: 'SECOND' as const, dayBooked: 14000 };
  assert.equal(lockFor(p, 0, cfg), -4000); // may lose 4k on trade 2
  assert.equal(lockFor(p, 10000, cfg), 5000);
  assert.equal(lockFor(p, 15000, cfg), 10000);
  assert.equal(lockFor({ dayPlan: 'SECOND', dayBooked: 10000 }, 0, cfg), 0); // break-even stop
});

// --- engine flow: long option, entry 100, 10 lots × 100 = 1000 qty (₹1,000 per point), T1 at 130 (beyond our moves)
const plan: TradePlan = { strike: 24000, direction: 'CE', entry: 100, sl: 90, target1: 130, target2: 145, riskPts: 10, rewardPts: 20, rr: '1:2.0', qty: 1000, maxLoss: 10000, potentialProfit: 30000 };
const enter = (s: EngineState, now: number) =>
  openTrade(s, cfg, { direction: 'CE', plan, entry: 100, qty: 1000, now, spot: 24000, confidence: 85, trend: '', pcr: 1, oiBias: '', iv: 11, delta: 0.5, reason: 'x' });
const T = Date.UTC(2026, 10, 6, 5, 0); // 10:30 IST

test('trade 1: +12.5k best → 7k secured → falls back → exits with 7k', () => {
  const s = initialEngineState();
  s.day = '2026-11-06';
  enter(s, T);
  assert.equal(s.position!.dayPlan, 'FIRST');
  checkAndCloseIfHit(s, 108.5, cfg, T + 1); // +8.5k: below the first step, normal SL
  assert.equal(s.position!.currentSl, 90);
  checkAndCloseIfHit(s, 109.2, cfg, T + 2); // +9.2k → 5k secured → stop 105
  assert.deepEqual([s.position!.lockedPnl, s.position!.currentSl], [5000, 105]);
  checkAndCloseIfHit(s, 112.5, cfg, T + 3); // +12.5k → 7k → stop 107
  assert.deepEqual([s.position!.lockedPnl, s.position!.currentSl], [7000, 107]);
  assert.equal(categoryOf(s.events[0]), 'lock');
  checkAndCloseIfHit(s, 106.9, cfg, T + 4); // falls through 107 → exit
  assert.equal(s.position, null);
  assert.equal(s.journal[0].pnl, 7000);
  assert.match(s.journal[0].exitReason, /^PROFIT LOCK HIT \(Rs 7000 secured\)/);
  // trade 2 after a 7k day: below the 10k floor → normal profit lock rules
  enter(s, T + 10);
  assert.equal(s.position!.dayPlan, 'NORMAL');
});

test('trade 2 after a 14k trade 1: the stop keeps the day at ≥ 10k (a 4k loss at most)', () => {
  const s = initialEngineState();
  s.day = '2026-11-06';
  enter(s, T);
  checkAndCloseIfHit(s, 114, cfg, T + 1); // +14k → 10k secured → stop 110
  checkAndCloseIfHit(s, 109.9, cfg, T + 2); // back to the lock → exits at 110 with 10k
  assert.equal(s.journal[0].pnl, 10000);
  s.realizedToday = 14000; // say it had booked 14k instead
  enter(s, T + 10);
  const p = s.position!;
  assert.deepEqual([p.dayPlan, p.dayBooked], ['SECOND', 14000]);
  checkAndCloseIfHit(s, 99, cfg, T + 11); // −1k: floor stop at 96 is tighter than the 90 SL
  assert.equal(p.currentSl, 96);
  checkAndCloseIfHit(s, 95.9, cfg, T + 12);
  assert.equal(s.position, null);
  assert.equal(s.journal[1].pnl, -4000);
  assert.equal(s.realizedToday, 10000); // the day still ends at 10k
  assert.match(s.journal[1].exitReason, /^DAY FLOOR HIT \(today kept at least Rs 10000\)/);
  assert.equal(categoryOf(s.events[0]), 'lock');
});

test('day plan off and profit lock off: the workbook exits (Target 2 on)', () => {
  const s = initialEngineState();
  const off = { ...cfg, dayPlanLock: false, profitLock: false };
  openTrade(s, off, { direction: 'CE', plan: { ...plan, target2: 112 }, entry: 100, qty: 1000, now: T, spot: 24000, confidence: 85, trend: '', pcr: 1, oiBias: '', iv: 11, delta: 0.5, reason: 'x' });
  assert.equal(s.position!.dayPlan, undefined);
  checkAndCloseIfHit(s, 131, off, T + 1); // T1 books half
  checkAndCloseIfHit(s, 113, off, T + 2); // T2 closes the rest
  assert.equal(s.position, null);
  assert.match(s.journal[0].exitReason, /^TARGET 2 HIT/);
});
