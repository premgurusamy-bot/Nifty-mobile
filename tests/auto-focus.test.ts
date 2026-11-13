/// <reference types="node" />
/** Auto-focus: only the strongest trend runs; the others are watched from candles; switch / ask with a trade. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EngineRunner } from '../src/lib/engine/runner.ts';
import type { TrendReport } from '../src/lib/engine/trend.ts';
import type { Candle, ChainSnapshot, EngineConfig, OpenPosition } from '../src/lib/engine/types.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/workbook-2026-08-27.json', import.meta.url), 'utf8'));
const t0 = fx.candles.at(-1).t + 60_000;
const K: Record<string, [number, number]> = { NIFTY: [1, 50], BANKNIFTY: [2.23, 100], FINNIFTY: [1.05, 50] };
const SYMS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY'];

function market(sym: string) {
  const [k, step] = K[sym];
  const candles: Candle[] = fx.candles.map((c: Candle) => ({ ...c, o: c.o * k, h: c.h * k, l: c.l * k, c: c.c * k }));
  const strikes = fx.chain.strikes.map((s: any) => {
    const strike = Math.round((s.strike * k) / step) * step;
    const leg = (l: any) => l && { ...l, ltp: l.ltp * k };
    return { strike, ce: leg(s.ce), pe: leg(s.pe) };
  });
  return { candles, chain: { ...fx.chain, spot: fx.chain.spot * k, strikes } as ChainSnapshot };
}

/** A runner on three indexes; the trend of each index is set by the test. */
async function setup() {
  const owner = new WeakMap<Candle[], string>();
  const loads: string[] = [];
  const candleLoads: string[] = [];
  const source = {
    load: async (cfg: EngineConfig) => {
      loads.push(cfg.symbol);
      const m = market(cfg.symbol);
      owner.set(m.candles, cfg.symbol);
      return m;
    },
    loadCandles: async (cfg: EngineConfig) => {
      candleLoads.push(cfg.symbol);
      const m = market(cfg.symbol);
      owner.set(m.candles, cfg.symbol);
      return m.candles;
    },
    now: () => t0,
    alwaysOpen: true,
  };
  const r = new EngineRunner(source as never, { load: async () => null, save: async () => {} });
  await r.init();
  await r.updateConfig({ multiIndex: true, watchSymbols: SYMS, lastEntryTime: '', autoFocus: true, autoEntry: false } as Partial<EngineConfig>);
  const trend: Record<string, { dir: 'UP' | 'DOWN' | 'SIDEWAYS'; strength: number; phase?: string }> = {
    NIFTY: { dir: 'UP', strength: 70 },
    BANKNIFTY: { dir: 'SIDEWAYS', strength: 20 },
    FINNIFTY: { dir: 'DOWN', strength: 40 },
  };
  r.focusTrend = (c) => {
    const t = trend[owner.get(c) ?? ''];
    return t ? ({ direction: t.dir, phase: t.phase ?? 'RUNNING', strength: t.strength } as unknown as TrendReport) : null;
  };
  const check = () => r.autoFocusTick(true);
  return { r, loads, candleLoads, trend, check };
}
const on = (r: EngineRunner) => SYMS.filter((s) => !r.isOff(s));

test('only the strongest trend runs; the others are switched off and watched from candles only', async () => {
  const { r, loads, candleLoads, check } = await setup();
  await r.refresh();
  await check();
  assert.equal(r.config.symbol, 'NIFTY');
  assert.deepEqual(on(r), ['NIFTY']);
  loads.length = 0;
  candleLoads.length = 0;
  await r.refresh();
  assert.deepEqual(loads, ['NIFTY'], 'only the focus loads its option chain');
  await check();
  assert.deepEqual(candleLoads.sort(), ['BANKNIFTY', 'FINNIFTY'], 'the others: candles only');
  const f = r.snapshot().focus!;
  assert.equal(f.symbol, 'NIFTY');
  assert.equal(f.trends.BANKNIFTY!.score, -1); // sideways: not tradeable
  assert.equal(f.trends.FINNIFTY!.strength, 40);
});

test('a clear new leader, seen twice, takes over; a small lead does not', async () => {
  const { r, trend, check } = await setup();
  await r.refresh();
  await check();
  trend.FINNIFTY = { dir: 'DOWN', strength: 75 }; // only 5 ahead: no switch
  await check();
  await check();
  assert.equal(r.config.symbol, 'NIFTY');
  trend.FINNIFTY = { dir: 'DOWN', strength: 85 };
  await check(); // first sighting
  assert.equal(r.config.symbol, 'NIFTY');
  await check(); // second: switch
  assert.equal(r.config.symbol, 'FINNIFTY');
  assert.deepEqual(on(r), ['FINNIFTY']);
  assert.match(r.state.events[0].message, /Auto-focus: now watching FINNIFTY only/);
  // The current one tiring counts as "not trending": a leader then needs no margin.
  trend.FINNIFTY = { dir: 'DOWN', strength: 90, phase: 'EXHAUSTING' };
  trend.NIFTY = { dir: 'UP', strength: 30 };
  await check();
  await check();
  assert.equal(r.config.symbol, 'NIFTY');
});

const position = (strike: number): OpenPosition =>
  ({ direction: 'CE', strike, entry: 100, originalSl: 90, target1: 120, target2: 130, totalQty: 65, journalId: 'J1', openedAt: t0, partialBooked: false, partialQty: 0, partialPnl: 0, remainingQty: 65, currentSl: 90, side: 1, pointValue: 1, symbol: 'NIFTY' }) as OpenPosition;

test('with a trade open: both run and you are asked; "stay" switches the leader off for 15 minutes', async () => {
  const { r, trend, check } = await setup();
  await r.refresh();
  await check();
  r.state = { ...r.state, position: position(24150) };
  trend.BANKNIFTY = { dir: 'UP', strength: 95 };
  await check();
  await check();
  assert.equal(r.config.symbol, 'NIFTY', 'the trade keeps the focus until you answer');
  assert.deepEqual(on(r).sort(), ['BANKNIFTY', 'NIFTY']);
  const p = r.snapshot().focus!.proposal!;
  assert.deepEqual([p.from, p.to, !!p.answered], ['NIFTY', 'BANKNIFTY', false]);
  assert.ok(r.state.events.some((e) => e.kind === 'SIGNAL' && /both run/.test(e.message)));
  await r.answerFocus(false);
  assert.deepEqual(on(r), ['NIFTY']);
  await check();
  await check();
  assert.equal(r.focusProposal, null, 'snoozed: not asked again at once');
});

test('"switch": the leader becomes the focus, the old index keeps its trade and turns off after it closes', async () => {
  const { r, trend, check } = await setup();
  await r.refresh();
  await check();
  r.state = { ...r.state, position: position(24150) };
  trend.BANKNIFTY = { dir: 'UP', strength: 95 };
  await check();
  await check();
  await r.answerFocus(true);
  assert.equal(r.config.symbol, 'BANKNIFTY');
  assert.deepEqual(on(r).sort(), ['BANKNIFTY', 'NIFTY'], 'NIFTY stays on for its trade');
  assert.equal(r.snapshot().focus!.proposal!.answered, true);
  await check();
  assert.deepEqual(on(r).sort(), ['BANKNIFTY', 'NIFTY']);
  // The NIFTY trade closes.
  const w = r.state.watch!;
  r.state = { ...r.state, watch: { ...w, NIFTY: { ...w.NIFTY, position: null } } };
  await check();
  assert.deepEqual(on(r), ['BANKNIFTY']);
  assert.equal(r.focusProposal, null);
});

test('auto-focus off: nothing is switched', async () => {
  const { r, check } = await setup();
  await r.updateConfig({ autoFocus: false } as Partial<EngineConfig>);
  await r.refresh();
  await check();
  assert.deepEqual(on(r), SYMS);
  assert.equal(r.snapshot().focus, undefined);
});
