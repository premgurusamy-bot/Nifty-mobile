/// <reference types="node" />
/**
 * Faster multi-index data: Dhan and Angel One indexes load at the same time, the 1-second ticks keep
 * running during a full refresh, and (only when refreshes stay slow) the least likely index pauses.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EngineRunner, migrateConfig } from '../src/lib/engine/runner.ts';
import { DEFAULT_CONFIG, type Candle, type ChainSnapshot, type EngineConfig } from '../src/lib/engine/types.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/workbook-2026-08-27.json', import.meta.url), 'utf8'));
const t0 = Date.UTC(2026, 7, 27, 6, 10, 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function market(k: number, step: number) {
  const candles: Candle[] = fx.candles.map((c: Candle) => ({ ...c, o: c.o * k, h: c.h * k, l: c.l * k, c: c.c * k }));
  const strikes = fx.chain.strikes.map((s: any) => {
    const leg = (l: any, side: string, strike: number) => l && { ...l, ltp: l.ltp * k, securityId: `${side}${strike}` };
    const strike = Math.round((s.strike * k) / step) * step;
    return { strike, ce: leg(s.ce, 'CE', strike), pe: leg(s.pe, 'PE', strike) };
  });
  return { candles, chain: { ...fx.chain, spot: fx.chain.spot * k, strikes } as ChainSnapshot };
}
const K: Record<string, [number, number]> = { NIFTY: [1, 50], BANKNIFTY: [2.23, 100], FINNIFTY: [1.05, 50] };

function setup(delayMs: (sym: string) => number, over: Partial<EngineConfig> = {}) {
  const log: string[] = [];
  const source = {
    laneOf: (cfg: EngineConfig) => (cfg.symbol === 'NIFTY' ? 'DHAN' : 'ANGEL'),
    load: async (cfg: EngineConfig) => {
      log.push(`start ${cfg.symbol}`);
      await sleep(delayMs(cfg.symbol));
      log.push(`end ${cfg.symbol}`);
      const [k, step] = K[cfg.symbol];
      return market(k, step);
    },
    now: () => t0,
  };
  const r = new EngineRunner(source as never, { load: async () => null, save: async () => {} });
  const ready = (async () => {
    await r.init();
    await r.updateConfig({ multiIndex: true, watchSymbols: ['NIFTY', 'BANKNIFTY', 'FINNIFTY'], lastEntryTime: '', ...over });
  })();
  return { r, log, ready };
}

test('lanes: the Dhan index loads at the same time as the Angel One ones (one after another within a lane)', async () => {
  const { r, log, ready } = setup(() => 120);
  await ready;
  const t = Date.now();
  await r.refresh();
  const took = Date.now() - t;
  assert.ok(took < 330, `took ${took} ms (3 × 120 ms one after another would be 360+)`);
  assert.deepEqual(log.slice(0, 2).sort(), ['start BANKNIFTY', 'start NIFTY']); // both lanes start together
  assert.ok(log.indexOf('start FINNIFTY') > log.indexOf('end BANKNIFTY')); // same lane: in turn
  assert.deepEqual(Object.keys(r.multiDash).sort(), ['BANKNIFTY', 'FINNIFTY', 'NIFTY']);
  assert.ok(r.lastLoadMs! >= 200);
});

test('ticks keep running while a full refresh is loading', async () => {
  let slow = false;
  const { r, ready } = setup(() => (slow ? 400 : 1));
  await ready;
  await r.refresh();
  let quotes = 0;
  r.quoteSource = async () => {
    quotes++;
    return { 'IDX_I|13': fx.chain.spot + 1 };
  };
  slow = true;
  const refreshing = r.refresh();
  await sleep(50);
  const t = Date.now();
  await r.tick(); // doesn't wait for the 400 ms load
  assert.ok(Date.now() - t < 200, 'tick finished during the refresh');
  assert.equal(quotes, 1);
  assert.ok(r.lastTick != null);
  await refreshing;
});

test('auto-pause: 3 slow refreshes pause the least likely index (not the one shown / in a trade); it comes back', async () => {
  const { r, ready } = setup(() => 30);
  await ready;
  r.shedSlowMs = 20; // "slow" for the test: every 30 ms load is slow
  r.shedFastMs = 5;
  for (let i = 0; i < 3; i++) await r.refresh();
  const paused = Object.keys(r.paused);
  assert.equal(paused.length, 1);
  assert.notEqual(paused[0], r.config.symbol);
  const conf = (s: string) => r.multiDash[s]?.decision.confidence ?? 99;
  const others = ['NIFTY', 'BANKNIFTY', 'FINNIFTY'].filter((s) => s !== r.config.symbol);
  assert.equal(paused[0], others.sort((a, b) => conf(a) - conf(b))[0]);
  assert.match(r.paused[paused[0]].reason, /Paused 10 min: data was slow/);
  assert.match(r.watchItems().find((w) => w.symbol === paused[0])!.decision, /Paused 10 min/);
  // Paused: not loaded any more.
  await r.refresh();
  assert.equal(r.multiDash[paused[0]], undefined);
  // Tapping it brings it back at once.
  await r.setActive(paused[0]);
  assert.equal(r.paused[paused[0]], undefined);
  // Switched off: never pauses.
  await r.updateConfig({ autoShed: false });
  for (let i = 0; i < 4; i++) await r.refresh();
  assert.deepEqual(Object.keys(r.paused), []);
});

test('saved settings: FIN NIFTY joins the watch list on Angel One once (rev 2); later choices are kept', () => {
  const old = { ...DEFAULT_CONFIG, watchSymbols: ['NIFTY', 'BANKNIFTY'], angelSymbols: ['BANKNIFTY'], angelOrderSymbols: ['BANKNIFTY'], configRev: 1 };
  const m = migrateConfig(old, old);
  assert.deepEqual([m.watchSymbols, m.angelSymbols, m.angelOrderSymbols], [
    ['NIFTY', 'BANKNIFTY', 'FINNIFTY'],
    ['BANKNIFTY', 'FINNIFTY'],
    ['BANKNIFTY', 'FINNIFTY'],
  ]);
  const later = { ...m, watchSymbols: ['NIFTY', 'BANKNIFTY'] };
  assert.deepEqual(migrateConfig(later, later).watchSymbols, ['NIFTY', 'BANKNIFTY']);
});
