/// <reference types="node" />
/**
 * Capital-based position sizing (paper / live capital, % of capital, Dhan balance,
 * MCX margin) and phone alerts (which events alert, once each, prefs).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { categoryOf, DEFAULT_ALERT_PREFS, loadPrefs, newAlerts, VOLUME } from '../src/lib/alerts.ts';
import { buildTradePlan, runCycle } from '../src/lib/engine/decision.ts';
import { buildFuturesPlan } from '../src/lib/engine/futures.ts';
import { computeTechnical } from '../src/lib/engine/indicators.ts';
import { EngineRunner, sanitizeConfig } from '../src/lib/engine/runner.ts';
import { sizingCapital } from '../src/lib/engine/sizing.ts';
import {
  DEFAULT_CONFIG,
  initialEngineState,
  type Candle,
  type ChainSnapshot,
  type EngineConfig,
  type EngineEvent,
} from '../src/lib/engine/types.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/workbook-2026-08-27.json', import.meta.url), 'utf8'));
const candles: Candle[] = fx.candles;
const chain: ChainSnapshot = fx.chain;
const atr = computeTechnical(candles)!.last.atr;
const pe = chain.strikes.find((s) => s.strike === 24200)!.pe!;
const capital = (over: Partial<EngineConfig>): EngineConfig =>
  sanitizeConfig({ sizingMode: 'CAPITAL', maxLots: 0, ...over }, DEFAULT_CONFIG);

test('sizing settings are validated', () => {
  const c = sanitizeConfig({ sizingMode: 'CAPITAL', capitalPaper: 50000, capitalLive: 0, capitalPct: 100 }, DEFAULT_CONFIG);
  assert.deepEqual([c.sizingMode, c.capitalPaper, c.capitalLive, c.capitalPct], ['CAPITAL', 50000, 0, 100]);
  assert.throws(() => sanitizeConfig({ capitalPct: 0 }, DEFAULT_CONFIG), /capitalPct/);
  assert.throws(() => sanitizeConfig({ capitalPct: 101 }, DEFAULT_CONFIG), /capitalPct/);
  assert.throws(() => sanitizeConfig({ sizingMode: 'ALL' as never }, DEFAULT_CONFIG), /sizingMode/);
  assert.equal(DEFAULT_CONFIG.sizingMode, 'RISK'); // the workbook's sizing stays the default
});

test('capital sizing (options): 100% of paper capital ÷ premium × lot size', () => {
  const cost = pe.ltp * 65;
  const p = buildTradePlan(chain, 'PE', 24200, atr, capital({ capitalPaper: 100000, capitalPct: 100 }))!;
  assert.equal(p.qty, Math.floor(100000 / cost) * 65);
  assert.ok(p.qty > 0 && !p.blocked);
  assert.match(p.sizing!, /paper capital/);
  // 50% → half the money
  const half = buildTradePlan(chain, 'PE', 24200, atr, capital({ capitalPaper: 100000, capitalPct: 50 }))!;
  assert.equal(half.qty, Math.floor(50000 / cost) * 65);
  // max lots still caps it
  const capped = buildTradePlan(chain, 'PE', 24200, atr, capital({ capitalPaper: 1e7, maxLots: 2 }))!;
  assert.equal(capped.qty, 2 * 65);
  // too little capital → 0 qty with a reason
  const poor = buildTradePlan(chain, 'PE', 24200, atr, capital({ capitalPaper: Math.floor(cost) - 1 }))!;
  assert.equal(poor.qty, 0);
  assert.match(poor.blocked!, /can't buy 1 lot/);
});

test('capital sizing (LIVE): live capital, else the Dhan available balance', () => {
  const live = capital({ tradeMode: 'LIVE', capitalPaper: 1, capitalLive: 200000, capitalPct: 100 });
  assert.equal(sizingCapital(live).capital, 200000);
  const bal = { ...capital({ tradeMode: 'LIVE', capitalLive: 0, capitalPct: 75 }), availableFunds: 80000 };
  assert.deepEqual([sizingCapital(bal).capital, sizingCapital(bal).source], [60000, 'Dhan available balance']);
  const unknown = buildTradePlan(chain, 'PE', 24200, atr, capital({ tradeMode: 'LIVE', capitalLive: 0 }))!;
  assert.equal(unknown.qty, 0);
  assert.match(unknown.blocked!, /not fetched yet/);
});

test('capital sizing (MCX futures): margin per lot, entered or estimated', () => {
  const gold = (over: Partial<EngineConfig>) => ({
      ...sanitizeConfig({ symbol: 'GOLDM' }, DEFAULT_CONFIG),
      sizingMode: 'CAPITAL' as const,
      maxLots: 0,
      ...over,
    });
  // Estimate: 12% of 120000 × ₹10 = ₹1,44,000 per lot
  const est = buildFuturesPlan('LONG', 120000, 40, gold({ capitalPaper: 500000 }))!;
  assert.equal(est.qty, 3);
  assert.match(est.sizing!, /est\. margin per lot/);
  const set = buildFuturesPlan('SHORT', 120000, 40, gold({ capitalPaper: 500000, marginPerLot: 100000, capitalPct: 50 }))!;
  assert.equal(set.qty, 2);
  assert.equal(buildFuturesPlan('LONG', 120000, 40, gold({ capitalPaper: 100000 }))!.qty, 0);
});

test('a capital-blocked confirmed signal does not paper-trade', () => {
  const cfg = capital({ capitalPaper: 10 });
  const now0 = Date.UTC(2026, 7, 27, 6, 10, 27);
  let r = runCycle({ ...initialEngineState(), ivHistory: fx.ivHistoryBefore }, cfg, { candles, chain, now: now0 });
  const trig = r.state.pending!.trigger;
  const last = candles[candles.length - 1];
  r = runCycle(r.state, cfg, { candles: [...candles.slice(0, -1), { ...last, l: trig - 1 }], chain, now: now0 + 30_000 });
  assert.equal(r.state.position, null);
  assert.equal(r.dashboard.decision.signal, 'NO TRADE');
  assert.match(r.dashboard.decision.decisionText, /^BLOCKED - Capital/);
});

test('LIVE: a confirmed signal raises one SIGNAL event (alerts once, no auto trade)', () => {
  const cfg = { ...DEFAULT_CONFIG, tradeMode: 'LIVE' as const };
  const now0 = Date.UTC(2026, 7, 27, 6, 10, 27);
  let r = runCycle({ ...initialEngineState(), ivHistory: fx.ivHistoryBefore }, cfg, { candles, chain, now: now0 });
  const trig = r.state.pending!.trigger;
  const last = candles[candles.length - 1];
  const broke = [...candles.slice(0, -1), { ...last, l: trig - 1 }];
  r = runCycle(r.state, cfg, { candles: broke, chain, now: now0 + 30_000 });
  assert.equal(r.state.position, null);
  assert.equal(r.state.events[0].kind, 'SIGNAL');
  assert.match(r.state.events[0].message, /^NIFTY BUY PE \d+ confirmed @ .* tap ENTER/);
  r = runCycle(r.state, cfg, { candles: broke, chain, now: now0 + 45_000 });
  assert.equal(r.state.events.filter((e) => e.kind === 'SIGNAL').length, 1);
});

test('runner: LIVE capital sizing fetches the Dhan balance; ENTER refuses an unaffordable plan', async () => {
  const store = { load: async () => null, save: async () => {} };
  const source = {
    load: async () => ({ candles, chain }),
    now: () => Date.UTC(2026, 7, 27, 6, 10, 27),
  };
  const r = new EngineRunner(source as never, store);
  await r.init();
  let calls = 0;
  r.fundsSource = async () => {
    calls++;
    return 1000;
  };
  await r.updateConfig({ tradeMode: 'LIVE', sizingMode: 'CAPITAL', capitalLive: 0, maxLots: 0 });
  await r.refresh();
  assert.ok(calls >= 1);
  assert.equal(r.funds, 1000);
  assert.equal(r.snapshot().capital!.capital, 1000);
  assert.throws(() => r.entryPlan(), /can't buy 1 lot/);
  // Enough balance → re-sized right away when the setting changes.
  r.fundsSource = async () => 1e6;
  await r.updateConfig({ capitalPct: 100 });
  assert.ok(r.entryPlan().qty > 0);
  // PAPER never asks Dhan.
  calls = 0;
  r.fundsSource = async () => {
    calls++;
    return 0;
  };
  await r.updateConfig({ tradeMode: 'PAPER', capitalPaper: 1e6 });
  await r.refresh();
  assert.equal(calls, 0);
});

// ---- alerts ----------------------------------------------------------------

const ev = (kind: EngineEvent['kind'], message: string, at = 1): EngineEvent => ({ kind, message, at });

test('alert categories', () => {
  assert.equal(categoryOf(ev('SIGNAL', 'x')), 'signal');
  assert.equal(categoryOf(ev('TRADE', 'NIFTY signal: BUY PE 24200 @ 80')), 'entry');
  assert.equal(categoryOf(ev('PARTIAL', 'booked')), 'target');
  assert.equal(categoryOf(ev('EXIT', 'PE 24200 closed - SL HIT (full) at 70')), 'stop');
  assert.equal(categoryOf(ev('EXIT', 'closed - SL HIT (exchange stop order) at 70')), 'stop');
  assert.equal(categoryOf(ev('EXIT', "closed - TARGET 1 HIT (full - only 1 lot, can't split)")), 'target');
  assert.equal(categoryOf(ev('EXIT', 'closed - TARGET 2 HIT (remainder) at 99')), 'exit');
  assert.equal(categoryOf(ev('EXIT', 'closed - MANUAL EXIT at 99')), 'exit');
  assert.equal(categoryOf(ev('INFO', 'x')), null);
});

test('alerts: old events stay quiet, each new event alerts once, categories filter', () => {
  const seen = new Set<string>();
  const old = [ev('TRADE', 'old entry', 1)];
  assert.deepEqual(newAlerts(old, seen, DEFAULT_ALERT_PREFS, true), []);
  const evs = [ev('EXIT', 'x closed - SL HIT (full) at 1', 3), ev('SIGNAL', 'sig', 2), ...old];
  const a = newAlerts(evs, seen, DEFAULT_ALERT_PREFS);
  assert.deepEqual(
    a.map((x) => [x.category, x.title]),
    [
      ['signal', 'Signal confirmed'],
      ['stop', 'Stop-loss hit'],
    ],
  );
  assert.deepEqual(newAlerts(evs, seen, DEFAULT_ALERT_PREFS), []);
  const noStops = { ...DEFAULT_ALERT_PREFS, categories: { ...DEFAULT_ALERT_PREFS.categories, stop: false } };
  assert.deepEqual(newAlerts([ev('EXIT', 'SL HIT', 9), ...evs], seen, noStops), []);
  const off = { ...DEFAULT_ALERT_PREFS, enabled: false };
  assert.deepEqual(newAlerts([ev('TRADE', 'n', 10)], seen, off), []);
});

test('alert prefs: volume levels and safe loading of old saves', () => {
  assert.deepEqual([VOLUME.LOW, VOLUME.MEDIUM, VOLUME.HIGH], [0.3, 0.6, 1]);
  const p = loadPrefs({ volume: 'LOUD', tone: 'custom', customUri: '', categories: { stop: false } });
  assert.equal(p.volume, 'MEDIUM');
  assert.equal(p.tone, 'chime'); // custom without a file falls back
  assert.equal(p.categories.stop, false);
  assert.equal(p.categories.signal, true);
  assert.deepEqual(loadPrefs(null), DEFAULT_ALERT_PREFS);
});
