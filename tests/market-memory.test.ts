/// <reference types="node" />
/** Market Memory: recording closed candles, tops / bottoms, the indicator scorecard, weights, export. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { analyse, findMoves, INDICATORS, movesCsv, recordsCsv, suggestWeights } from '../src/lib/memory/analysis.ts';
import { indicatorSeries } from '../src/lib/memory/indicators.ts';
import { FACTORS, MarketMemory, memoryStore, type CandleRecord } from '../src/lib/memory/recorder.ts';
import { runCycle } from '../src/lib/engine/decision.ts';
import { EngineRunner } from '../src/lib/engine/runner.ts';
import { DEFAULT_CONFIG, initialEngineState, type Candle, type ChainSnapshot } from '../src/lib/engine/types.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/workbook-2026-08-27.json', import.meta.url), 'utf8'));
const candles: Candle[] = fx.candles;
const chain: ChainSnapshot = fx.chain;
const cfg = { ...DEFAULT_CONFIG, lastEntryTime: '' };

test('candle indicators: a steady rise reads as up (EMA20 > EMA50, RSI high, +DI > −DI)', () => {
  const c: Candle[] = Array.from({ length: 60 }, (_, i) => ({ t: Date.parse('2026-11-12T03:45:00Z') + i * 300_000, o: 100 + i, h: 101 + i, l: 99.5 + i, c: 100.8 + i, v: 1000 }));
  const x = indicatorSeries(c).at(-1)!;
  assert.ok(x.ema20 > x.ema50);
  assert.ok(x.rsi > 70, String(x.rsi));
  assert.ok(x.pdi > x.mdi && x.adx > 20, JSON.stringify(x));
  assert.ok(x.vwap > 100 && x.vwap < 160);
});

test('recording: a candle is stored once when the next one starts, with scores, factors and premiums', async () => {
  const store = memoryStore();
  const mm = new MarketMemory(store);
  const now = candles.at(-1)!.t + 60_000;
  const r = runCycle({ ...initialEngineState(), ivHistory: fx.ivHistoryBefore }, cfg, { candles, chain, now });
  mm.observe('NIFTY', candles, chain, r.dashboard, 65);
  mm.observe('NIFTY', candles, chain, r.dashboard, 65); // same candle: nothing yet
  await mm.flush();
  assert.equal(store.files.size, 0);
  const last = candles.at(-1)!;
  const next = [...candles, { ...last, t: last.t + 300_000, o: last.c, h: last.c, l: last.c }];
  mm.observe('NIFTY', next, chain, r.dashboard, 65);
  mm.observe('NIFTY', next, chain, r.dashboard, 65);
  await mm.flush();
  const recs = await mm.load(await mm.days());
  assert.equal(recs.length, 1);
  const rec = recs[0];
  assert.equal(rec.t, last.t);
  assert.equal(rec.c, last.c);
  assert.equal(rec.fCE!.length, FACTORS.length);
  assert.equal(rec.fPE!.length, FACTORS.length);
  assert.ok(rec.sCE >= 0 && rec.sPE >= 0 && rec.conf > 0);
  assert.ok(Object.keys(rec.prem).length >= 5, 'strikes around the money');
  assert.ok(rec.prem[String(rec.atm)][0] > 0 && rec.prem[String(rec.atm)][1] > 0);
  assert.equal(rec.lot, 65);
  // Off: nothing more is recorded.
  mm.enabled = false;
  mm.observe('NIFTY', [...next, { ...last, t: last.t + 600_000 }], chain, r.dashboard, 65);
  await mm.flush();
  assert.equal((await mm.load(await mm.days())).length, 1);
});

test('the engine records live cycles when Market Memory is attached (and nothing when it is not)', async () => {
  let data = candles;
  let t = candles.at(-1)!.t + 60_000;
  const runner = new EngineRunner({ load: async () => ({ candles: data, chain }), now: () => t, alwaysOpen: true }, { load: async () => ({ state: { ...initialEngineState(), ivHistory: fx.ivHistoryBefore }, config: cfg }), save: async () => {} });
  await runner.init();
  const store = memoryStore();
  runner.memory = new MarketMemory(store);
  await runner.refresh();
  const last = candles.at(-1)!;
  data = [...candles, { ...last, t: last.t + 300_000 }];
  t += 300_000;
  await runner.refresh();
  await runner.memory.flush();
  assert.equal((await runner.memory.load(await runner.memory.days())).length, 1);
  // A failing recorder never breaks the engine cycle.
  runner.memory.observe = () => {
    throw new Error('boom');
  };
  t += 1000;
  await runner.refresh();
  assert.doesNotMatch(runner.status, /^Error/);
});

// ---------------------------------------------------------------- synthetic market for the analysis

const T0 = Date.parse('2026-11-02T03:45:00Z'); // 09:15 IST, Monday
/** One index-day: price path `p` (one close per candle); the EMA factor and RSI follow the next move. */
function day(d: number, p: number[], s = 'NIFTY'): CandleRecord[] {
  return p.map((c, i) => {
    const next = p[Math.min(p.length - 1, i + 3)] - c; // what the next 15 minutes do
    const up = next > 0;
    const strike = Math.round(c / 50) * 50;
    const prem: Record<string, [number, number]> = {};
    for (let k = -3; k <= 3; k++) {
      const K = strike + 50 * k;
      prem[String(K)] = [Math.max(1, 100 + (c - K) * 0.5), Math.max(1, 100 + (K - c) * 0.5)];
    }
    const f = (good: boolean) => FACTORS.map((_, j) => (j === 0 ? (good ? 15 : 0) : 5));
    return {
      s,
      t: T0 + d * 86400_000 + i * 300_000,
      o: c,
      h: c + 2,
      l: c - 2,
      c,
      ind: { ema20: c, ema50: c, vwap: c, rsi: up ? 60 : 40, adx: 25, pdi: 20, mdi: 15, atr: 8 },
      spot: c,
      pcr: 1,
      iv: 12,
      ivp: 50,
      dir: up ? 'CE' : 'PE',
      conf: up ? 85 : 30,
      sCE: up ? 70 : 40,
      sPE: up ? 40 : 70,
      fCE: f(up), // EMA trend factor (index 0) always points to the next move
      fPE: f(!up),
      atm: strike,
      prem,
      lot: 65,
    };
  });
}
/** 24000 down 60 pts, up 160, down 100 (5-minute steps of 10 points). */
const path = [...Array.from({ length: 7 }, (_, i) => 24000 - 10 * i), ...Array.from({ length: 16 }, (_, i) => 23950 + 10 * (i + 1)), ...Array.from({ length: 10 }, (_, i) => 24110 - 10 * (i + 1))];

test('tops and bottoms: bottom → top and top → bottom moves with the best strike and who called them', () => {
  const recs = day(0, path);
  const mv = findMoves(recs);
  assert.ok(mv.length >= 2, JSON.stringify(mv));
  const rep = analyse(recs, { confHigh: 80 });
  const upMove = rep.moves.find((m) => m.dir === 'UP')!;
  assert.equal(upMove.start.price, 23940);
  assert.equal(upMove.end.price, 24110);
  assert.equal(upMove.best!.side, 'CE');
  assert.ok(upMove.best!.gainPct > 0 && upMove.best!.perLot > 0);
  assert.ok(upMove.predicted.some((p) => p.key === 'emaTrend'), 'the EMA factor pointed up at the bottom');
  assert.ok(upMove.keyCandles.length > 0);
  const down = rep.moves.find((m) => m.dir === 'DOWN')!;
  assert.equal(down.best!.side, 'PE');
});

test('scorecard: the factor that predicts the move ranks top; neutral ones show no signals', () => {
  const recs = [0, 1, 2, 3].flatMap((d) => day(d, path));
  const rep = analyse(recs, { confHigh: 80 });
  const ema = rep.scorecard.find((x) => x.key === 'emaTrend')!;
  assert.ok(ema.signals >= 60 && ema.enough);
  assert.ok(ema.hitRate! > 80, String(ema.hitRate));
  assert.ok(ema.perLot! > 0);
  assert.equal(rep.scorecard[0].hitRate! >= ema.hitRate! - 1e-9, true);
  const pcr = rep.scorecard.find((x) => x.key === 'pcr')!;
  assert.equal(pcr.signals, 0); // equal points on both sides: no view
  assert.ok(rep.agreement.length > 0);
  assert.equal(INDICATORS.length, rep.scorecard.length);
});

test('weights: not before enough data; learnt on older days and tested on newer ones; suggestions only', () => {
  const few = analyse(day(0, path), { confHigh: 80 }).weights;
  assert.equal(few.ready, false);
  const many = [...Array(16).keys()].flatMap((d) => day(d, path));
  const w = suggestWeights(many, 40);
  assert.ok(w.ready, JSON.stringify(w));
  if (w.ready) {
    assert.equal(w.factors[0].key, 'emaTrend');
    assert.ok(w.factors[0].suggested > 90, 'nearly all the weight on the factor that works');
    assert.ok(w.testDays >= 2 && w.trainDays > w.testDays);
    assert.ok(w.suggestedAcc >= w.currentAcc);
  }
});

test('export: CSV of candles and of moves', () => {
  const recs = day(0, path);
  const rows = recordsCsv(recs).split('\n');
  assert.equal(rows.length, recs.length + 1);
  assert.match(rows[0], /^index,time_ist,open,high,low,close,ema20/);
  assert.match(rows[0], /ce_emaTrend/);
  assert.match(rows[1], /^NIFTY,2026-11-02 09:15,/);
  const mv = movesCsv(analyse(recs, { confHigh: 80 }).moves).split('\n');
  assert.ok(mv.length >= 3);
  assert.match(mv[0], /best_strike/);
});
