/// <reference types="node" />
/** Portfolio strategy results, journal fields (qty / mode / exit time), and the live fill amendment. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAndCloseIfHit, openTrade } from '../src/lib/engine/decision.ts';
import { EngineRunner } from '../src/lib/engine/runner.ts';
import { DEFAULT_CONFIG, initialEngineState, type JournalRow, type OpenPosition } from '../src/lib/engine/types.ts';
import { optionCharges, rowMode, strategyResults } from '../src/lib/results.ts';

const row = (over: Partial<JournalRow>): JournalRow => ({
  id: 'J', date: '2026-11-04', time: '10:00:00', spot: 0, strike: 24000, direction: 'CE', entry: 100, sl: 90,
  target: 120, exit: 110, pnl: 650, confidence: 85, trend: '', pcr: 1, oiBias: '', iv: 11, delta: 0.5,
  entryReason: 'Auto-signal: SETUP', exitReason: 'TARGET 2 HIT (remainder) (auto-closed)', ...over,
});

test('results: win rate, profit factor, drawdown, today, per mode', () => {
  const j = [
    row({ id: 'A', pnl: 1000, date: '2026-11-03' }),
    row({ id: 'B', pnl: -400, date: '2026-11-03' }),
    row({ id: 'C', pnl: -300, date: '2026-11-04' }),
    row({ id: 'D', pnl: 900, date: '2026-11-04' }),
    row({ id: 'E', pnl: null, exit: null }), // open
    row({ id: 'L', pnl: -5000, entryReason: 'Manual LIVE entry: …' }), // old LIVE row (no mode field)
    row({ id: 'M', pnl: 2000, mode: 'LIVE' }),
  ];
  const p = strategyResults(j, 'PAPER', '2026-11-04');
  assert.deepEqual([p.trades, p.wins, p.losses, p.net, p.grossProfit, p.grossLoss], [4, 2, 2, 1200, 1900, -700]);
  assert.equal(p.winRate, 50);
  assert.ok(Math.abs(p.profitFactor! - 1900 / 700) < 1e-9);
  assert.equal(p.maxDrawdown, -700); // 1000 → 600 → 300
  assert.equal(p.today, 600);
  assert.deepEqual([p.best, p.worst, p.avgWin, p.avgLoss], [1000, -400, 950, -350]);
  assert.deepEqual(p.recent.map((x) => x.id), ['D', 'C', 'B', 'A']);
  const l = strategyResults(j, 'LIVE', '2026-11-04');
  assert.deepEqual([l.trades, l.net], [2, -3000]);
  assert.equal(rowMode(j[5]), 'LIVE');
  assert.equal(strategyResults([], 'PAPER', '').winRate, null);
});

test('estimated charges: one option round trip, only where quantity is known', () => {
  // 650 × 78.35 → 87.00: ≈ ₹150 (brokerage 40, STT 56.55, exchange 37.65, GST ~14, stamp 1.53, SEBI 0.11)
  const c = optionCharges(78.35, 87, 650);
  assert.ok(Math.abs(c - 149.85) < 0.1, String(c));
  const r = strategyResults([row({ qty: 650, entry: 78.35, exit: 87 }), row({ id: 'X' })], 'PAPER', '');
  assert.ok(Math.abs(r.estCharges! - c) < 1e-9);
  assert.equal(r.chargesUnknown, 1);
});

test('new journal rows record quantity, mode and exit time', () => {
  const s = initialEngineState();
  const plan = { strike: 24000, direction: 'CE' as const, entry: 100, sl: 90, target1: 120, target2: 130, riskPts: 10, rewardPts: 20, rr: '1:2.0', qty: 130, maxLoss: 1300, potentialProfit: 2600 };
  const now = Date.UTC(2026, 10, 4, 5, 0); // 10:30 IST
  openTrade(s, DEFAULT_CONFIG, { direction: 'CE', plan, entry: 100, qty: 130, now, spot: 24000, confidence: 85, trend: '', pcr: 1, oiBias: '', iv: 11, delta: 0.5, reason: 'x' });
  assert.deepEqual([s.journal[0].qty, s.journal[0].mode], [130, 'PAPER']);
  checkAndCloseIfHit(s, 89, DEFAULT_CONFIG, now + 20 * 60_000);
  assert.equal(s.journal[0].exitTime, '10:50:00');
});

test('live exit amended to the real fill: short MCX P&L uses side and ₹ per point', async () => {
  const r = new EngineRunner({ load: async () => ({}) as never }, { load: async () => null, save: async () => {} });
  const leg: OpenPosition = {
    direction: 'SHORT', strike: 0, entry: 120000, originalSl: 120100, target1: 119800, target2: 119700, totalQty: 1,
    journalId: 'J1', openedAt: 0, partialBooked: false, partialQty: 0, partialPnl: 0, remainingQty: 1,
    currentSl: 120100, side: -1, pointValue: 10, symbol: 'GOLDM',
  };
  // engine recorded the exit at the stop 120100 → −1,000; Dhan actually filled at 120130 → −1,300
  r.state = { ...r.state, realizedToday: -1000, journal: [row({ id: 'J1', direction: 'SHORT', entry: 120000, exit: 120100, pnl: -1000 })] };
  await r.amendExit(leg, 120130, 'live fill');
  assert.equal(r.state.journal[0].pnl, -1300);
  assert.equal(r.state.realizedToday, -1300);
});
