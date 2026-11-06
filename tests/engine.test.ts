/// <reference types="node" />
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runBacktest, summarizeJournal } from '../src/lib/engine/backtest.ts';
import {
  buildTradePlan,
  canTakeNewTrade,
  checkAndCloseIfHit,
  ivPercentile,
  runCycle,
} from '../src/lib/engine/decision.ts';
import { computeChainMetrics, computeTechnical } from '../src/lib/engine/indicators.ts';
import { livePriceAction } from '../src/lib/engine/priceAction.ts';
import {
  DEFAULT_CONFIG,
  initialEngineState,
  type Candle,
  type ChainSnapshot,
  type EngineState,
  type OpenPosition,
} from '../src/lib/engine/types.ts';

/** The workbook's rule: enter on the first break after the trade level (no hold). */
const WB_CONFIG = { ...DEFAULT_CONFIG, confirmHoldMinutes: 0 };

/**
 * Golden fixture: inputs AND outputs of the workbook's last refresh
 * (02_LiveMarket candles, 03_OptionChain, 12_IVHistory → 01_Dashboard, 04_Analytics).
 */
const fx = JSON.parse(readFileSync(new URL('./fixtures/workbook-2026-08-27.json', import.meta.url), 'utf8'));
const candles: Candle[] = fx.candles;
const chain: ChainSnapshot = fx.chain;
const E = fx.expected;
const close = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} != ${b}`);

test('golden: EMA20/EMA50/VWAP/ATR match the workbook on every candle', () => {
  const t = computeTechnical(candles)!;
  fx.expectedTechnical.forEach(([e20, e50, vw, atr]: number[], i: number) => {
    close(t.ema20[i], e20);
    close(t.ema50[i], e50);
    close(t.vwap[i], vw);
    close(t.atr[i], atr);
  });
  assert.equal(t.trend, E.trend);
  close(t.last.atr, E.atr);
});

test('golden: PCR, max pain, OI support/resistance, ATM match', () => {
  const m = computeChainMetrics(chain)!;
  close(m.pcr, E.pcr);
  assert.equal(m.maxPain, E.maxPain);
  assert.equal(m.support, E.support);
  assert.equal(m.resistance, E.resistance);
  assert.equal(m.atm, E.atm);
});

test('golden: swing support/resistance match', () => {
  const t = computeTechnical(candles)!;
  const pa = livePriceAction(candles, t, E.support, E.resistance);
  assert.equal(pa.swingSupport, E.swingSupport);
  assert.equal(pa.swingResistance, E.swingResistance);
});

test('golden: full cycle reproduces the confidence score, its 10-factor breakdown, Greeks and IV snapshot', () => {
  const state: EngineState = { ...initialEngineState(), ivHistory: fx.ivHistoryBefore };
  const now = Date.UTC(2026, 7, 27, 6, 10, 27); // 11:40:27 IST
  const { state: next, dashboard: d } = runCycle(state, WB_CONFIG, { candles, chain, now });

  close(next.ivHistory[next.ivHistory.length - 1], fx.ivCaptured);
  close(d.decision.confidence, E.confidence);
  const b = d.breakdown;
  const got = [
    b.emaTrend,
    b.vwapPosition,
    b.priceAction,
    b.oiBias,
    b.pcr,
    b.deltaFit,
    b.ivLevel,
    b.gamma,
    b.thetaDrag,
    b.volume,
  ];
  got.forEach((v, i) => close(v, E.breakdown[i]));
  assert.equal(d.decision.direction, 'PE');
  const g = d.greeks;
  [g.delta, g.gamma, g.theta, g.vega, g.iv].forEach((v, i) => close(v, E.greeks[i]));
  assert.equal(d.chain.ceLtp, E.ceLtp);
  assert.equal(d.chain.peLtp, E.peLtp);
  assert.equal(d.chain.ceOi, E.ceOi);
  assert.equal(d.chain.peOi, E.peOi);
  assert.equal(d.chain.changeInOi, E.changeInOi);
  assert.equal(d.decision.sentiment, E.sentiment);
  assert.equal(d.decision.oiStrength, E.oiStrength);
  // 88.9 ≥ 80 with no open position → the setup arms (first stage of the confirmation cycle).
  assert.equal(d.decision.signal, 'WAIT');
  assert.match(d.decision.decisionText, /^SETUP ARMED - waiting for break of 24154\.40/);
});

// ---- State machine ----------------------------------------------------------

const mkCandle = (t: number, o: number, h: number, l: number, c: number): Candle => ({ t, o, h, l, c, v: 1000 });

test('staged decision: arm → pending → confirmed break fires once and opens a position', () => {
  const now0 = Date.UTC(2026, 7, 27, 6, 10, 27);
  let st: EngineState = { ...initialEngineState(), ivHistory: fx.ivHistoryBefore };
  let r = runCycle(st, WB_CONFIG, { candles, chain, now: now0 });
  const trigger = r.state.pending!.trigger;
  assert.equal(r.state.pending!.direction, 'PE');

  // Same candle again → still pending.
  r = runCycle(r.state, WB_CONFIG, { candles, chain, now: now0 + 15_000 });
  assert.match(r.dashboard.decision.decisionText, /^SETUP PENDING/);

  // Latest candle low breaks the trigger → trade fires.
  const last = candles[candles.length - 1];
  const broke = [...candles.slice(0, -1), { ...last, l: trigger - 1 }];
  r = runCycle(r.state, WB_CONFIG, { candles: broke, chain, now: now0 + 30_000 });
  assert.equal(r.dashboard.decision.signal, 'BUY PE');
  assert.ok(r.dashboard.plan);
  assert.equal(r.state.tradesToday, 1);
  assert.equal(r.state.journal.length, 1);
  assert.match(r.state.journal[0].entryReason, /^Auto-signal: SETUP PENDING - waiting for break of/);
  assert.ok(r.state.position);
  assert.equal(r.state.events[0].kind, 'TRADE');

  // Next cycle → IN POSITION, no new setups.
  r = runCycle(r.state, WB_CONFIG, { candles: broke, chain, now: now0 + 45_000 });
  assert.equal(r.dashboard.decision.signal, 'IN POSITION');
  st = r.state;
  assert.equal(st.pending, null);
});

test('trade plan: ATR × multiplier × delta risk, sized to max risk per trade', () => {
  const t = computeTechnical(candles)!;
  const p = buildTradePlan(chain, 'PE', 24200, t.last.atr, WB_CONFIG)!;
  // Workbook's live trade on this strike: entry 82.65 … here entry is this snapshot's LTP.
  const leg = chain.strikes.find((s) => s.strike === 24200)!.pe!;
  close(p.riskPts, t.last.atr * 1.5 * Math.abs(leg.delta));
  close(p.target1, p.entry + p.riskPts * 2);
  close(p.target2, p.entry + p.riskPts * 3);
  assert.equal(p.qty % 65, 0);
  assert.equal(p.qty, Math.max(1, Math.floor(2000 / (p.riskPts * 65))) * 65);
  assert.equal(p.rr, '1:2.0');
});

const pos = (over: Partial<OpenPosition> = {}): OpenPosition => ({
  direction: 'PE',
  strike: 24200,
  entry: 82.65,
  originalSl: 70.96,
  target1: 106.03,
  target2: 117.72,
  totalQty: 130,
  journalId: 'J1',
  openedAt: 0,
  partialBooked: false,
  partialQty: 0,
  partialPnl: 0,
  remainingQty: 130,
  currentSl: 70.96,
  ...over,
});
const withPos = (p: OpenPosition): EngineState => ({
  ...initialEngineState(),
  day: '2026-08-27',
  position: p,
  journal: [
    {
      id: 'J1',
      date: '2026-08-27',
      time: '10:33:45',
      spot: 0,
      strike: 24200,
      direction: 'PE',
      entry: 82.65,
      sl: 70.96,
      target: 106.03,
      exit: null,
      pnl: null,
      confidence: 87.5,
      trend: 'BEARISH',
      pcr: 0.62,
      oiBias: '',
      iv: 8,
      delta: -0.45,
      entryReason: '',
      exitReason: '',
    },
  ],
});

test('position: T1 books half (2 lots) and trails SL to breakeven, then T2 closes the rest', () => {
  const s = withPos(pos());
  assert.ok(checkAndCloseIfHit(s, 106.5, WB_CONFIG, 1));
  assert.equal(s.position!.partialBooked, true);
  assert.equal(s.position!.remainingQty, 65);
  assert.equal(s.position!.currentSl, 82.65);
  close(s.realizedToday, (106.03 - 82.65) * 65);
  assert.match(s.journal[0].exitReason, /^Partial: booked 65 @ 106\.03 \(\+Rs 1520\), SL trailed to breakeven 82\.65$/);

  assert.ok(checkAndCloseIfHit(s, 118, WB_CONFIG, 2));
  assert.equal(s.position, null);
  close(s.journal[0].pnl!, (106.03 - 82.65) * 65 + (117.72 - 82.65) * 65);
  assert.match(s.journal[0].exitReason, /^TARGET 2 HIT \(remainder\)/);
});

test('position: SL hit closes in full at the SL level; single lot exits fully at T1', () => {
  const s = withPos(pos());
  checkAndCloseIfHit(s, 60, WB_CONFIG, 1);
  close(s.journal[0].pnl!, (70.96 - 82.65) * 130);
  assert.match(s.journal[0].exitReason, /^SL HIT \(full\)/);

  const one = withPos(pos({ totalQty: 65, remainingQty: 65 }));
  checkAndCloseIfHit(one, 110, WB_CONFIG, 1);
  assert.equal(one.position, null);
  assert.match(one.journal[0].exitReason, /only 1 lot/);
});

test('daily discipline: trade limit, no-revenge rule, rupee max loss', () => {
  const s = { ...initialEngineState(), day: '2026-08-27' };
  assert.equal(canTakeNewTrade(s, WB_CONFIG).ok, true);
  assert.match(canTakeNewTrade({ ...s, tradesToday: 3 }, WB_CONFIG).reason, /Daily trade limit reached \(3\/3\)/);
  const lost = withPos(pos());
  lost.position = null;
  lost.journal[0].pnl = -100;
  assert.match(canTakeNewTrade(lost, WB_CONFIG).reason, /No-revenge/);
  assert.match(canTakeNewTrade({ ...s, realizedToday: -3000 }, WB_CONFIG).reason, /Daily max loss/);
});

test('IV percentile needs 20 snapshots', () => {
  assert.equal(ivPercentile([10, 11], 10), -1);
  const h = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(ivPercentile(h, 4), 20);
});

test('summary groups closed trades by day with cumulative P&L', () => {
  const j = [
    { date: '2026-08-17', pnl: 4191.41 },
    { date: '2026-08-17', pnl: -1559.61 },
    { date: '2026-08-27', pnl: null },
  ].map((x, i) => ({ ...withPos(pos()).journal[0], id: `J${i}`, ...x }));
  const s = summarizeJournal(j);
  assert.equal(s.length, 1);
  assert.deepEqual([s[0].trades, s[0].wins, s[0].losses], [2, 1, 1]);
  close(s[0].cumulative, 2631.8);
});

test('backtest replays the workbook candles', () => {
  const r = runBacktest(candles, WB_CONFIG);
  assert.equal(r.candles, 225);
  assert.ok(r.armed >= r.confirmed);
  assert.equal(r.wins + r.losses + r.timedOut, r.confirmed);
  for (const t of r.trades) assert.ok(t.direction === 'CE' || t.direction === 'PE');
});
