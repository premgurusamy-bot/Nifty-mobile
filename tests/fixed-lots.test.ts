/// <reference types="node" />
/** Fixed-lots sizing: your lots, your stop-loss % of the premium (1–40), capital check, MCX unchanged stop. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildTradePlan } from '../src/lib/engine/decision.ts';
import { buildFuturesPlan } from '../src/lib/engine/futures.ts';
import { computeTechnical } from '../src/lib/engine/indicators.ts';
import { sanitizeConfig } from '../src/lib/engine/runner.ts';
import { DEFAULT_CONFIG, type ChainSnapshot, type EngineConfig } from '../src/lib/engine/types.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/workbook-2026-08-27.json', import.meta.url), 'utf8'));
const chain: ChainSnapshot = fx.chain;
const atr = computeTechnical(fx.candles)!.last.atr;
const fixed = (over: Partial<EngineConfig> = {}) =>
  sanitizeConfig({ sizingMode: 'FIXED', fixedLots: 2, fixedStopPct: 20, ...over }, DEFAULT_CONFIG);

test('settings: FIXED mode, whole lots, stop 1–40%', () => {
  const c = fixed();
  assert.deepEqual([c.sizingMode, c.fixedLots, c.fixedStopPct], ['FIXED', 2, 20]);
  assert.throws(() => fixed({ fixedStopPct: 41 }), /fixedStopPct must be between 1 and 40/);
  assert.throws(() => fixed({ fixedStopPct: 0 }), /fixedStopPct/);
  assert.throws(() => fixed({ fixedLots: 1.5 }), /whole number/);
  assert.throws(() => fixed({ fixedLots: 0 }), /fixedLots/);
});

test('real 27 Aug PE 24150 @ 78.35: 2 lots, SL 20% → 62.70, targets at 2× / 3× the stop', () => {
  const p = buildTradePlan(chain, 'PE', 24150, atr, fixed())!;
  assert.equal(p.entry, 78.35);
  assert.equal(p.qty, 130);
  assert.equal(p.riskPts, 15.65); // 20% of 78.35 = 15.67 → on the 0.05 tick
  assert.equal(p.sl, 62.7);
  assert.ok(Math.abs(p.target1 - (78.35 + 2 * 15.65)) < 1e-9);
  assert.ok(Math.abs(p.target2 - (78.35 + 3 * 15.65)) < 1e-9);
  assert.ok(Math.abs(p.maxLoss - 15.65 * 130) < 1e-9);
  assert.match(p.sizing!, /^Fixed 2 lot\(s\) · max loss ₹2,035$/);
  assert.equal(p.blocked, undefined);
});

test('40% stop is allowed (the 25% stop filter does not apply); min premium still does', () => {
  const p = buildTradePlan(chain, 'PE', 24150, atr, fixed({ fixedStopPct: 40 }))!;
  assert.equal(p.blocked, undefined);
  assert.equal(p.riskPts, 31.35);
  const cheap: ChainSnapshot = {
    ...chain,
    strikes: chain.strikes.map((s) => (s.strike === 24150 ? { ...s, pe: { ...s.pe!, ltp: 35 } } : s)),
  };
  assert.match(buildTradePlan(cheap, 'PE', 24150, atr, fixed())!.blocked!, /below the minimum/);
});

test('max lots still caps; capital that cannot pay for the lots blocks the trade', () => {
  assert.equal(buildTradePlan(chain, 'PE', 24150, atr, fixed({ fixedLots: 30, capitalPaper: 1e7 }))!.qty, 25 * 65); // cap 25
  assert.match(buildTradePlan(chain, 'PE', 24150, atr, fixed({ fixedLots: 30, capitalPaper: 1e7 }))!.sizing!, /\(max lots 25\)/);
  // 10 lots × 65 × 78.35 = ₹50,927 > ₹40,000 paper capital
  // Premium for 10 lots (₹50,928) > ₹40,000 capital: lots adjusted down to what it can pay for (7).
  const fit = buildTradePlan(chain, 'PE', 24150, atr, fixed({ fixedLots: 10, capitalPaper: 40000 }))!;
  assert.equal(fit.qty, 7 * 65);
  assert.equal(fit.blocked, undefined);
  assert.match(fit.sizing!, /^Fixed 10 lot\(s\) → 7 by capital \(₹40,000 paper capital ÷ ₹5,093 premium per lot\)/);
  // Not even one lot: refused, with the reason.
  const poor = buildTradePlan(chain, 'PE', 24150, atr, fixed({ fixedLots: 10, capitalPaper: 4000 }))!;
  assert.equal(poor.qty, 0);
  assert.match(poor.blocked!, /^1 lot needs ₹5,093 \(premium per lot\) but paper capital is ₹4,000$/);
  // LIVE with the Dhan balance not fetched yet: not blocked here (Dhan refuses if funds are short)
  assert.equal(buildTradePlan(chain, 'PE', 24150, atr, { ...fixed({ tradeMode: 'LIVE' }), availableFunds: null })!.qty, 130);
});

test('MCX futures: fixed lots, ATR stop unchanged', () => {
  const g = { ...sanitizeConfig({ symbol: 'GOLDM' }, DEFAULT_CONFIG), sizingMode: 'FIXED' as const, fixedLots: 1, maxLots: 0 };
  const p = buildFuturesPlan('LONG', 120000, 40, { ...g, capitalPaper: 1e7 })!;
  assert.deepEqual([p.qty, p.riskPts, p.sl], [1, 60, 119940]);
});
