/// <reference types="node" />
/** Hold before entry: the score must stay at the trade level for N minutes and not fade, then the break must come. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runCycle } from '../src/lib/engine/decision.ts';
import { sanitizeConfig } from '../src/lib/engine/runner.ts';
import { DEFAULT_CONFIG, initialEngineState, type Candle, type ChainSnapshot, type EngineState } from '../src/lib/engine/types.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/workbook-2026-08-27.json', import.meta.url), 'utf8'));
const candles: Candle[] = fx.candles;
const chain: ChainSnapshot = fx.chain;
const t0 = Date.UTC(2026, 7, 27, 6, 10, 0); // 11:40:00 IST
const min = 60_000;
const cfg = { ...DEFAULT_CONFIG, lastEntryTime: '' }; // default hold: 5 min, must hold or rise

/** Same market with the PE OI scaled so PCR moves (changes only the PCR / OI-bias points). */
const withPePcr = (f: number): ChainSnapshot => ({
  ...chain,
  strikes: chain.strikes.map((s) => ({ ...s, pe: s.pe && { ...s.pe, oi: s.pe.oi * f } })),
});
const last = candles[candles.length - 1];
let trig = 0;
const broke = () => [...candles.slice(0, -1), { ...last, l: trig - 1 }];
const cycle = (s: EngineState, now: number, opts: { ch?: ChainSnapshot; brk?: boolean; c?: typeof cfg } = {}) =>
  runCycle(s, opts.c ?? cfg, { candles: opts.brk ? broke() : candles, chain: opts.ch ?? chain, now });
const start = () => {
  const r = cycle({ ...initialEngineState(), ivHistory: fx.ivHistoryBefore }, t0);
  trig = r.state.pending!.trigger;
  return r;
};

test('defaults: hold 5 minutes, score must hold or rise; validated', () => {
  assert.deepEqual([DEFAULT_CONFIG.confirmHoldMinutes, DEFAULT_CONFIG.confirmRising], [5, true]);
  assert.equal(sanitizeConfig({ confirmHoldMinutes: 0 }, DEFAULT_CONFIG).confirmHoldMinutes, 0);
  assert.throws(() => sanitizeConfig({ confirmHoldMinutes: 61 }, DEFAULT_CONFIG), /confirmHoldMinutes/);
});

test('reaching 80 arms a hold; a break during the hold does not enter', () => {
  let r = start();
  assert.match(r.dashboard.decision.decisionText, /^SETUP ARMED - score 88\.9, holding 5 min before entry, then break of /);
  r = cycle(r.state, t0 + 1 * min, { brk: true });
  assert.equal(r.state.position, null);
  assert.match(r.dashboard.decision.decisionText, /^SETUP HOLDING - score steady since 88\.9, entry check at 11:45:00 \(/);
  r = cycle(r.state, t0 + 4 * min + 59_000, { brk: true });
  assert.equal(r.state.position, null);
});

test('held 5 minutes at the same or a higher score, then the break → enters', () => {
  let r = start();
  r = cycle(r.state, t0 + 2 * min);
  r = cycle(r.state, t0 + 5 * min, { brk: true });
  assert.ok(r.state.position, r.dashboard.decision.decisionText);
  assert.equal(r.dashboard.decision.signal, 'BUY PE');
});

test('held 5 minutes but no break yet → waits for the break, then enters', () => {
  let r = start();
  r = cycle(r.state, t0 + 5 * min);
  assert.match(r.dashboard.decision.decisionText, /^SETUP PENDING - waiting for break of/);
  r = cycle(r.state, t0 + 6 * min, { brk: true });
  assert.ok(r.state.position);
});

test('a dip below 80 during the hold restarts it', () => {
  let r = start();
  r = cycle(r.state, t0 + 3 * min, { ch: withPePcr(1.75) }); // PCR ~0.97 → score falls below 80 (WATCH)
  assert.ok(r.dashboard.decision.confidence < 80, String(r.dashboard.decision.confidence));
  assert.equal(r.state.pending!.holdFrom, null);
  r = cycle(r.state, t0 + 4 * min); // back to 88.9: a new hold starts now
  assert.equal(r.state.pending!.holdFrom, t0 + 4 * min);
  r = cycle(r.state, t0 + 6 * min, { brk: true }); // only 2 min of the new hold
  assert.equal(r.state.position, null);
  r = cycle(r.state, t0 + 9 * min, { brk: true }); // 5 min of the new hold
  assert.ok(r.state.position);
});

test('a score weaker than at the start of the hold (fading) does not enter; the hold starts again', () => {
  let r = start(); // 88.9
  const weaker = withPePcr(1.3); // PCR ~0.72 → still ≥ 80, but lower
  r = cycle(r.state, t0 + 5 * min, { ch: weaker, brk: true });
  const c = r.dashboard.decision.confidence;
  assert.ok(c >= 80 && c < 88.89, String(c));
  assert.equal(r.state.position, null);
  assert.match(r.dashboard.decision.decisionText, /^SETUP FADING - score \d+\.\d is below 88\.9 where the hold started; holding again/);
  // A new 5-minute hold from the weaker score; steady at it → enters
  r = cycle(r.state, t0 + 10 * min, { ch: weaker, brk: true });
  assert.ok(r.state.position);
});

test('"must hold or rise" off: a weaker but still ≥ 80 score enters after the hold', () => {
  let r = start();
  r = cycle(r.state, t0 + 5 * min, { ch: withPePcr(1.3), brk: true, c: { ...cfg, confirmRising: false } });
  assert.ok(r.state.position);
});

test('hold 0: the workbook rule — the first break after 80 enters', () => {
  const c0 = { ...cfg, confirmHoldMinutes: 0 };
  let r = cycle({ ...initialEngineState(), ivHistory: fx.ivHistoryBefore }, t0, { c: c0 });
  trig = r.state.pending!.trigger;
  r = cycle(r.state, t0 + 30_000, { brk: true, c: c0 });
  assert.ok(r.state.position);
});
