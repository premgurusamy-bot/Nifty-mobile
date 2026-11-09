/// <reference types="node" />
/** Cheap-premium filters: minimum premium and maximum stop-loss % of premium (options only). */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildTradePlan, runCycle } from '../src/lib/engine/decision.ts';
import { buildFuturesPlan } from '../src/lib/engine/futures.ts';
import { computeTechnical } from '../src/lib/engine/indicators.ts';
import { sanitizeConfig } from '../src/lib/engine/runner.ts';
import { DEFAULT_CONFIG, initialEngineState, type Candle, type ChainSnapshot } from '../src/lib/engine/types.ts';

/** The workbook's rule: enter on the first break after the trade level (no hold). */
const WB_CONFIG = { ...DEFAULT_CONFIG, confirmHoldSeconds: 0, dayPlanLock: false };

const fx = JSON.parse(readFileSync(new URL('./fixtures/workbook-2026-08-27.json', import.meta.url), 'utf8'));
const candles: Candle[] = fx.candles;
const chain: ChainSnapshot = fx.chain;
const atr = computeTechnical(candles)!.last.atr;
/** The golden chain with the PE 24150 premium replaced. */
const withPremium = (ltp: number): ChainSnapshot => ({
  ...chain,
  strikes: chain.strikes.map((s) => (s.strike === 24150 ? { ...s, pe: { ...s.pe!, ltp } } : s)),
});

test('defaults: minimum ₹40, max stop 25%; validated', () => {
  assert.deepEqual([WB_CONFIG.minPremium, WB_CONFIG.maxStopPct], [40, 25]);
  assert.equal(sanitizeConfig({ minPremium: 0, maxStopPct: 0 }, WB_CONFIG).maxStopPct, 0);
  assert.throws(() => sanitizeConfig({ maxStopPct: 120 }, WB_CONFIG), /maxStopPct/);
  assert.throws(() => sanitizeConfig({ minPremium: -1 }, WB_CONFIG), /minPremium/);
});

test('the real 27 Aug PE plan (78.35, stop 10.9%) passes both filters', () => {
  const p = buildTradePlan(chain, 'PE', 24150, atr, WB_CONFIG)!;
  assert.equal(p.blocked, undefined);
  assert.ok(p.qty > 0);
});

test('premium below the minimum is blocked', () => {
  const p = buildTradePlan(withPremium(38), 'PE', 24150, atr, WB_CONFIG)!;
  assert.equal(p.qty, 0);
  assert.equal(p.blocked, 'Premium 38.00 is below the minimum 40.00');
  assert.ok(buildTradePlan(withPremium(38), 'PE', 24150, atr, { ...WB_CONFIG, minPremium: 0, maxStopPct: 0 })!.qty > 0);
});

test('a stop that is too large a share of the premium is blocked', () => {
  // stop 8.55 pts: 8.55 / 32 = 26.7% > 25%  (min premium off to isolate the % rule)
  const cfg = { ...WB_CONFIG, minPremium: 0 };
  const p = buildTradePlan(withPremium(32), 'PE', 24150, atr, cfg)!;
  assert.equal(p.qty, 0);
  assert.match(p.blocked!, /^Stop-loss is 26\.\d% of the premium \(max 25%\)$/);
  assert.equal(buildTradePlan(withPremium(36), 'PE', 24150, atr, cfg)!.blocked, undefined); // 23.8%
  assert.ok(buildTradePlan(withPremium(32), 'PE', 24150, atr, { ...cfg, maxStopPct: 30 })!.qty > 0);
});

test('a blocked cheap setup does not trade and says why', () => {
  const cheap = withPremium(30);
  const now0 = Date.UTC(2026, 7, 27, 6, 10, 27);
  let r = runCycle({ ...initialEngineState(), ivHistory: fx.ivHistoryBefore }, WB_CONFIG, { candles, chain: cheap, now: now0 });
  const trig = r.state.pending!.trigger;
  const last = candles[candles.length - 1];
  r = runCycle(r.state, WB_CONFIG, { candles: [...candles.slice(0, -1), { ...last, l: trig - 1 }], chain: cheap, now: now0 + 30_000 });
  assert.equal(r.state.position, null);
  assert.equal(r.dashboard.decision.decisionText, 'BLOCKED - Premium 30.00 is below the minimum 40.00');
  assert.match(r.dashboard.candidatePlan!.blocked!, /below the minimum/);
});

test('MCX futures are not affected', () => {
  const gold = sanitizeConfig({ symbol: 'GOLDM' }, WB_CONFIG);
  assert.equal(buildFuturesPlan('LONG', 120000, 40, gold)!.blocked, undefined);
});
