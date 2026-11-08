/// <reference types="node" />
/** Gap finder: size, full / partial, fill, first-15-minute range, status; and the engine's gap guard. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findGap, gapEntryBlock } from '../src/lib/engine/trend.ts';
import type { Candle } from '../src/lib/engine/types.ts';

const D1 = Date.UTC(2026, 10, 9, 3, 45); // Mon 09:15 IST
const D2 = Date.UTC(2026, 10, 10, 3, 45); // Tue 09:15 IST
const bar = (t: number, o: number, c: number, h = Math.max(o, c) + 3, l = Math.min(o, c) - 3): Candle => ({ t, o, h, l, c, v: 0 });
/** Yesterday: 24,000 → 24,100 (high 24,120, low 23,980). */
const yesterday = (): Candle[] =>
  Array.from({ length: 75 }, (_, i) => {
    const c = 24000 + (100 * i) / 74;
    return bar(D1 + i * 300_000, c - 1, c, i === 50 ? 24120 : c + 3, i === 5 ? 23980 : c - 3);
  });
const today = (pts: number[]) => pts.map((c, i) => bar(D2 + i * 300_000, i ? pts[i - 1] : pts[0], c));

test('flat open', () => {
  const g = findGap([...yesterday(), ...today([24110, 24115, 24105, 24112])])!;
  assert.equal(g.kind, 'FLAT');
  assert.equal(g.status, 'FLAT');
  assert.equal(g.prevClose, 24100);
});

test('gap up waiting for the first 15 minutes, then gap-and-go when it breaks the opening high', () => {
  const opening = [24300, 24320, 24310]; // +0.83% open; first 15 min high ≈ 24323
  let g = findGap([...yesterday(), ...today(opening)])!;
  assert.deepEqual([g.kind, g.full, g.status], ['GAP_UP', true, 'WAIT_15']);
  assert.ok(Math.abs(g.gapPct - 0.83) < 0.01, `${g.gapPct}`);
  g = findGap([...yesterday(), ...today([...opening, 24330, 24345])])!;
  assert.equal(g.orb.broke, 'UP');
  assert.equal(g.status, 'GAP_AND_GO');
  assert.match(g.verdict, /gap-and-go — CE with it/);
});

test('gap up that falls back: filling, then filled at yesterday’s close', () => {
  let g = findGap([...yesterday(), ...today([24300, 24290, 24280, 24250, 24190])])!;
  assert.equal(g.status, 'FILLING');
  assert.ok(g.fillNowPct > 50);
  g = findGap([...yesterday(), ...today([24300, 24290, 24280, 24200, 24120, 24095])])!;
  assert.equal(g.filled, true);
  assert.equal(g.status, 'FILLED');
});

test('gap down (partial: inside yesterday’s range) holding inside the opening range', () => {
  const g = findGap([...yesterday(), ...today([24000, 23995, 24005, 24000])])!;
  assert.equal(g.kind, 'GAP_DOWN');
  assert.equal(g.full, false); // above yesterday's low 23,980
  assert.equal(g.status, 'HOLDING');
});

test('no previous day in the data → no gap report', () => {
  assert.equal(findGap(today([24300, 24310, 24320])), null);
});

test('gap guard: blocks entries in the first 15 minutes after a big gap only', () => {
  const c = [...yesterday(), ...today([24300, 24320])];
  assert.match(gapEntryBlock(c, D2 + 10 * 60_000, 0.5)!, /^Gap up 0\.83% at the open — waiting for the first 15 minutes \(until 09:30\)/);
  assert.equal(gapEntryBlock(c, D2 + 15 * 60_000, 0.5), null); // 09:30: free
  assert.equal(gapEntryBlock(c, D2 + 10 * 60_000, 1), null); // smaller than the setting
  assert.equal(gapEntryBlock([...yesterday(), ...today([24110])], D2 + 60_000, 0.5), null); // flat
});
