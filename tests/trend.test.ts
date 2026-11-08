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
  assert.deepEqual(r.snapshot().trend!.NIFTY, r.snapshot().trend!.NIFTY); // same report between polls
});

test('entry strength: a fast trend that pays for theta is strong; a slow one, dear IV or a tiring trend is weak', async () => {
  const { entryStrength } = await import('../src/lib/engine/trend.ts');
  const closes = [...line(24300, -6, 30, 3), ...line(24120, 8, 40, 3)];
  const c = path(closes);
  const t = findTrend(c)!;
  const leg = { strike: 24400, ltp: 120, delta: 0.5, gamma: 0.0008, theta: -12, vega: 9, iv: 13 };
  const good = entryStrength(t, c, leg, { ivPercentile: 25, daysToExpiry: 4 })!;
  assert.equal(good.side, 'CE');
  assert.ok(good.speedPtsHr > 50, `speed ${good.speedPtsHr}`);
  assert.ok(good.edge >= 3, `edge ${good.edge}`); // ~48 pts/hr × 0.5 delta vs 12/6.25 per hour
  assert.equal(good.label, 'STRONG');
  // Same trend, but heavy time decay and dear IV.
  const dear = entryStrength(t, c, { ...leg, theta: -150 }, { ivPercentile: 90, daysToExpiry: 0.3 })!;
  assert.ok(dear.edge < good.edge / 3, `edge ${dear.edge} vs ${good.edge}`);
  assert.ok(dear.score <= good.score - 15, `${dear.score} vs ${good.score}`);
  assert.ok(dear.notes.some((n) => /IV is high/.test(n)));
  assert.ok(dear.notes.some((n) => /Expiry today/.test(n)));
  // A tiring / breaking trend drags it down whatever the Greeks.
  const broken = entryStrength({ ...t, phase: 'REVERSING' }, c, leg, { ivPercentile: 25, daysToExpiry: 4 })!;
  assert.ok(broken.score < good.score - 40);
  assert.equal(entryStrength(t, c, null, { ivPercentile: null, daysToExpiry: 4 }), null);
  // A tiring trend is never STRONG; an unknown IV percentile (-1) is shown as unknown.
  const tiring = entryStrength({ ...t, phase: 'EXHAUSTING' }, c, leg, { ivPercentile: -1, daysToExpiry: 4 })!;
  assert.ok(tiring.score <= 60 && tiring.label !== 'STRONG');
  assert.equal(tiring.ivPercentile, null);
});

test('the snapshot carries the entry strength for the strike the engine would pick', async () => {
  const { EngineRunner } = await import('../src/lib/engine/runner.ts');
  const fx = JSON.parse(readFileSync(new URL('./fixtures/workbook-2026-08-27.json', import.meta.url), 'utf8'));
  const r = new EngineRunner({ load: async () => ({ candles: fx.candles, chain: fx.chain }), now: () => Date.UTC(2026, 7, 27, 6, 10) } as never, {
    load: async () => null,
    save: async () => {},
  });
  await r.init();
  await r.refresh();
  const e = r.snapshot().trend!.NIFTY.entry!;
  assert.equal(e.side, 'PE'); // the downtrend's side
  assert.ok(e.premium > 0 && e.delta !== 0);
  assert.ok(e.score >= 0 && e.score <= 100);
});
