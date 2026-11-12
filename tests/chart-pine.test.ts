/// <reference types="node" />
/** Chart data in the snapshot, and the Pine Script (TradingView) generator. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EngineRunner } from '../src/lib/engine/runner.ts';
import { DEFAULT_CONFIG, initialEngineState, type Candle, type ChainSnapshot } from '../src/lib/engine/types.ts';
import { pineScore, pineStrategy } from '../src/lib/pine.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/workbook-2026-08-27.json', import.meta.url), 'utf8'));
const candles: Candle[] = fx.candles;
const chain: ChainSnapshot = fx.chain;
const mine = {
  ...DEFAULT_CONFIG,
  sizingMode: 'RISK' as const,
  maxLots: 10,
  lotSize: 65,
  confHigh: 80,
  lastEntryTime: '14:35',
  profitLock: true,
  lockStart: 10000,
  lockStep: 7500,
  lockRideFrom: 15000,
  lockRideAmount: 6000,
};

/** Pine needs 4-space blocks: every line indented by a multiple of 4, no tabs, and a block after each `if` / function. */
function wellIndented(src: string) {
  const lines = src.split('\n');
  lines.forEach((l, i) => {
    assert.ok(!l.includes('\t'), `tab on line ${i + 1}`);
    const ind = l.match(/^ */)![0].length;
    assert.equal(ind % 4, 0, `line ${i + 1}: "${l}"`);
    if (/^\s*(if |else|f_lock\(pk\) =>)/.test(l) && !l.trim().startsWith('//')) {
      const next = lines[i + 1] ?? '';
      assert.ok(next.match(/^ */)![0].length === ind + 4, `block after line ${i + 1}: "${l}"`);
    }
  });
}

test('Pine strategy: v5, made from your settings, the app rules, well-formed blocks', () => {
  const s = pineStrategy(mine);
  assert.match(s, /^\/\/ Nifty Trader/);
  assert.match(s, /\/\/@version=5\nstrategy\("Nifty Trader — strategy", overlay=true/);
  assert.match(s, /lots {6}= input\.int\(10, "Lots"/); // RISK sizing → the max-lots cap
  assert.match(s, /lotSize {3}= input\.int\(65,/);
  assert.match(s, /input\.session\("0930-1435"/);
  assert.match(s, /lockStart = input\.float\(10000,/);
  assert.match(s, /lockStep {2}= input\.float\(7500,/);
  assert.match(s, /rideFrom {2}= input\.float\(15000,/);
  assert.match(s, /rideAmt {3}= input\.float\(6000,/);
  assert.match(s, /useLock {3}= input\.bool\(true,/);
  assert.match(s, /scoreMin {2}= input\.float\(80,/);
  for (const part of ['ta.ema(close, 20)', 'ta.vwap(hlc3)', 'ta.atr(14)', 'qty_percent=50', 'strategy.entry("CE", strategy.long', 'strategy.entry("PE", strategy.short', 'lostToday := true', '"Asia/Kolkata"'])
    assert.ok(s.includes(part), part);
  // v2 has a gap guard setting (on by default); the licensed v1 has none.
  if ('gapGuard' in DEFAULT_CONFIG) assert.match(s, /gapGuard {2}= input\.bool\(true,/);
  assert.match(pineStrategy({ ...mine, gapGuard: undefined }), /gapGuard {2}= input\.bool\(false,/); // licensed v1: no gap guard
  wellIndented(s);
  // Fixed lots: the lot count is the fixed one.
  assert.match(pineStrategy({ ...mine, sizingMode: 'FIXED', fixedLots: 16 }), /input\.int\(16, "Lots"/);
});

test('Pine score panel: CE / PE scores and the trade / watch levels', () => {
  const s = pineScore({ confHigh: 80, confWatch: 65, symbol: 'NIFTY' });
  assert.match(s, /\/\/@version=5\nindicator\("Nifty Trader — score", overlay=false\)/);
  assert.match(s, /tradeLevel = input\.float\(80,/);
  assert.match(s, /watchLevel = input\.float\(65,/);
  assert.ok(s.includes('plot(scoreCE') && s.includes('plot(scorePE'));
  wellIndented(s);
});

test('the snapshot carries the selected index\'s latest candles for the chart', async () => {
  const runner = new EngineRunner(
    { load: async () => ({ candles, chain }), now: () => candles.at(-1)!.t + 60_000, alwaysOpen: true },
    { load: async () => ({ state: { ...initialEngineState(), ivHistory: fx.ivHistoryBefore }, config: DEFAULT_CONFIG }), save: async () => {} },
  );
  await runner.init();
  await runner.refresh();
  const snap = runner.snapshot();
  assert.equal(snap.candles!.length, Math.min(150, candles.length));
  assert.deepEqual(snap.candles!.at(-1), candles.at(-1));
});
