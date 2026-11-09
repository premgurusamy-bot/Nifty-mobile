/// <reference types="node" />
/** 3-second auto-refresh: setting limits, timer pacing, IV snapshot spacing, throttled saves. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runCycle } from '../src/lib/engine/decision.ts';
import { EngineRunner, sanitizeConfig } from '../src/lib/engine/runner.ts';
import { DEFAULT_CONFIG, initialEngineState, MIN_REFRESH_SECONDS, type Candle, type ChainSnapshot } from '../src/lib/engine/types.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/workbook-2026-08-27.json', import.meta.url), 'utf8'));
const candles: Candle[] = fx.candles;
const chain: ChainSnapshot = fx.chain;
const t0 = Date.UTC(2026, 7, 27, 6, 10, 27); // 11:40 IST

test('refresh interval: 3 s minimum', () => {
  assert.equal(MIN_REFRESH_SECONDS, 3);
  assert.equal(sanitizeConfig({ refreshSeconds: 3 }, DEFAULT_CONFIG).refreshSeconds, 3);
  assert.throws(() => sanitizeConfig({ refreshSeconds: 2 }, DEFAULT_CONFIG), /refreshSeconds must be between 3 and 3600/);
});

test('IV snapshots: at most one per 15 s, however fast the refresh', () => {
  let s = { ...initialEngineState(), ivHistory: [] as number[] };
  for (let i = 0; i < 20; i++) s = runCycle(s, DEFAULT_CONFIG, { candles, chain, now: t0 + i * 3000 }).state; // 57 s of 3-s refreshes
  assert.equal(s.ivHistory.length, 4); // at 0, 15, 30, 45 s
  // a clock that jumps back (new demo session) still records
  s = runCycle(s, DEFAULT_CONFIG, { candles, chain, now: t0 - 3600_000 }).state;
  assert.equal(s.ivHistory.length, 5);
});

test('3-s refreshes: saves are throttled to one per 15 s when nothing changes', async () => {
  let now = t0;
  let loads = 0;
  let saves = 0;
  const r = new EngineRunner(
    {
      load: async () => {
        loads++;
        return { candles, chain };
      },
      now: () => now,
    },
    { load: async () => null, save: async () => void saves++ },
  );
  await r.init();
  await r.updateConfig({ autoRefresh: true, refreshSeconds: 3, lastEntryTime: '', confirmHoldSeconds: 0 });
  r.stop(); // drive the timer by hand
  await r.refresh();
  const s0 = saves;
  // 30 quiet refreshes 3 s apart (same candles → same decision): at most one save per 15 s
  for (let i = 1; i <= 30; i++) {
    now = t0 + i * 3000;
    await r.refresh();
  }
  assert.equal(loads, 31);
  assert.ok(saves - s0 <= 7, `saves ${saves - s0}`); // 90 s → ~6 throttled saves (+ the setup change)
  assert.ok(saves - s0 >= 5);
});

test('the auto-refresh timer fires 3 s after the last refresh, not sooner', async () => {
  let now = t0;
  let loads = 0;
  const r = new EngineRunner(
    { load: async () => (loads++, { candles, chain }), now: () => now },
    { load: async () => null, save: async () => {} },
  );
  await r.init();
  await r.updateConfig({ refreshSeconds: 3, lastEntryTime: '' });
  await r.updateConfig({ autoRefresh: true });
  r.stop();
  r.syncTimer(5); // tick every 5 ms of real time; the engine clock is moved by hand
  const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
  await wait(60);
  assert.equal(loads, 1); // first refresh
  now = t0 + 2900;
  await wait(60);
  assert.equal(loads, 1); // 2.9 s: not yet
  now = t0 + 3000;
  await wait(60);
  assert.equal(loads, 2); // 3 s: refreshed
  r.stop();
});
