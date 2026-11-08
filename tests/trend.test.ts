/// <reference types="node" />
/** Trend finder: direction, real start (turning point), age, strength, ending signs. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { findTrend, to15m } from '../src/lib/engine/trend.ts';
import type { Candle } from '../src/lib/engine/types.ts';

const T0 = Date.UTC(2026, 10, 9, 3, 45); // 09:15 IST
/** Candles from a list of closes (each candle spans its open→close with a small wick). */
function path(closes: number[], start = T0): Candle[] {
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { t: start + i * 300_000, o, h: Math.max(o, c) + 2, l: Math.min(o, c) - 2, c, v: 1000 };
  });
}
const line = (from: number, step: number, n: number, wiggle = 0) =>
  Array.from({ length: n }, (_, i) => from + step * i + (i % 2 ? wiggle : -wiggle));

test('a clear uptrend after a downtrend: UP, started at the low, age and move', () => {
  const closes = [...line(24300, -6, 30, 3), ...line(24120, 8, 40, 3)]; // down 30 candles, then up 40
  const r = findTrend(path(closes))!;
  assert.equal(r.direction, 'UP');
  assert.ok(['RUNNING', 'MATURE', 'STARTING'].includes(r.phase), r.phase);
  // The start is the turning point (the low around candle 29–30), not the later EMA crossover.
  const lowIdx = (r.startedAt! - T0) / 300_000;
  assert.ok(lowIdx >= 28 && lowIdx <= 31, `start at candle ${lowIdx}`);
  assert.ok(r.ageMin >= 190 && r.ageMin <= 215, `age ${r.ageMin}`);
  assert.ok(r.movePts > 250, `move ${r.movePts}`);
  assert.ok(r.strength >= 60, `strength ${r.strength}`);
  assert.match(r.verdict, /UP trend/);
  assert.equal(r.today.at(-1)!.dir, 'UP');
});

test('a flat, choppy market is SIDEWAYS', () => {
  const closes = Array.from({ length: 80 }, (_, i) => 24200 + (i % 4 < 2 ? 6 : -6));
  const r = findTrend(path(closes))!;
  assert.equal(r.direction, 'SIDEWAYS');
  assert.equal(r.phase, 'SIDEWAYS');
  assert.match(r.verdict, /No clear trend/);
});

test('ending signs: an uptrend that breaks its last higher low is BREAKING', () => {
  const up = line(24000, 7, 50, 2);
  // pullback (makes a higher low), new high, then a sharp drop through that higher low
  const tail = [24330, 24320, 24310, 24318, 24330, 24345, 24360, 24355, 24300, 24270, 24250];
  const r = findTrend(path([...up, ...tail]))!;
  assert.equal(r.lean, 'UP');
  assert.ok(r.warnings.some((w) => /Structure broken|closed back below EMA20/.test(w)), r.warnings.join(' | '));
  assert.ok(['REVERSING', 'EXHAUSTING'].includes(r.phase), r.phase);
});

test('too few candles → no report; 15-min candles are three 5-min candles', () => {
  assert.equal(findTrend(path(line(100, 1, 20))), null);
  const c15 = to15m(path(line(100, 1, 9)));
  assert.equal(c15.length, 3);
  assert.deepEqual([c15[0].o, c15[0].c], [100, 102]);
});

test('the workbook day (27 Aug): a running downtrend from the open', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/workbook-2026-08-27.json', import.meta.url), 'utf8'));
  const r = findTrend(fx.candles)!;
  assert.equal(r.direction, 'DOWN');
  assert.equal(r.higherTf, 'DOWN');
  assert.ok(r.ageMin >= 60);
  assert.ok(r.movePts < 0);
});

test('the engine ships a trend report per index with its snapshot', async () => {
  const { EngineRunner } = await import('../src/lib/engine/runner.ts');
  const fx = JSON.parse(readFileSync(new URL('./fixtures/workbook-2026-08-27.json', import.meta.url), 'utf8'));
  const r = new EngineRunner({ load: async () => ({ candles: fx.candles, chain: fx.chain }), now: () => Date.UTC(2026, 7, 27, 6, 10) } as never, {
    load: async () => null,
    save: async () => {},
  });
  await r.init();
  await r.refresh();
  assert.equal(r.snapshot().trend!.NIFTY.direction, 'DOWN');
  assert.equal(r.snapshot().trend!.NIFTY, r.snapshot().trend!.NIFTY); // cached between polls
});
