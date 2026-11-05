/// <reference types="node" />
/**
 * Confidence calibration: NIFTY scoring is unchanged; the same market at BANK NIFTY / FIN NIFTY price
 * levels scores the same; % thresholds follow each instrument's volatility (options and MCX).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { calibrationFor, NIFTY_REF, NO_CALIBRATION } from '../src/lib/engine/calibration.ts';
import { runCycle, scoreDirection } from '../src/lib/engine/decision.ts';
import { evaluateFutures } from '../src/lib/engine/futures.ts';
import { computeTechnical } from '../src/lib/engine/indicators.ts';
import { sanitizeConfig } from '../src/lib/engine/runner.ts';
import { DEFAULT_CONFIG, initialEngineState, type Candle } from '../src/lib/engine/types.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/workbook-2026-08-27.json', import.meta.url), 'utf8'));
const now = Date.UTC(2026, 7, 27, 6, 10, 27);

/** The real 27 Aug NIFTY market, scaled to another index's price level (prices × k, theta × k, gamma ÷ k). */
function scaled(k: number, step: number, thetaBoost = 1) {
  const candles = fx.candles.map((c: Candle) => ({ ...c, o: c.o * k, h: c.h * k, l: c.l * k, c: c.c * k }));
  const strikes = fx.chain.strikes.map((s: any) => {
    const leg = (l: any) => l && { ...l, ltp: l.ltp * k, theta: l.theta * k * thetaBoost, gamma: l.gamma / k, vega: l.vega * k };
    return { strike: Math.round((s.strike * k) / step) * step, ce: leg(s.ce), pe: leg(s.pe) };
  });
  return { candles, chain: { ...fx.chain, spot: fx.chain.spot * k, strikes } };
}
const score = (sym: string, k: number, step: number, thetaBoost = 1) => {
  const cfg = sanitizeConfig({ symbol: sym }, DEFAULT_CONFIG);
  const r = runCycle({ ...initialEngineState(), ivHistory: fx.ivHistoryBefore }, cfg, { ...scaled(k, step, thetaBoost), now });
  return r.dashboard;
};

test('NIFTY: no calibration at all — the workbook score is unchanged', () => {
  assert.deepEqual(calibrationFor({ symbol: 'NIFTY', lotSize: 65 }, 99999, 999), NO_CALIBRATION);
  const d = score('NIFTY', 1, 50);
  assert.ok(Math.abs(d.decision.confidence - 88.89840619701363) < 1e-9);
});

test('the same market at BANK NIFTY and FIN NIFTY price levels scores exactly like NIFTY', () => {
  const n = score('NIFTY', 1, 50);
  for (const [sym, k, step] of [['BANKNIFTY', 2.23, 100], ['FINNIFTY', 1.03, 50]] as const) {
    const d = score(sym, k, step);
    assert.equal(d.decision.direction, n.decision.direction, sym);
    assert.ok(Math.abs(d.decision.confidence - n.decision.confidence) < 1e-9, `${sym} ${d.decision.confidence}`);
    assert.deepEqual(d.breakdown, n.breakdown);
  }
});

test('busier day (theta × 2): BANK NIFTY keeps NIFTY’s theta points instead of dropping to 0', () => {
  const n = score('NIFTY', 1, 50, 2);
  const b = score('BANKNIFTY', 2.23, 100, 2);
  assert.equal(b.breakdown.thetaDrag, n.breakdown.thetaDrag);
  assert.ok(Math.abs(b.decision.confidence - n.decision.confidence) < 1e-9);
});

test('calibration factors: price, volatility (bounded) and lot size', () => {
  const c = calibrationFor({ symbol: 'BANKNIFTY', lotSize: 30 }, 54000, 54000 * 0.0011); // ATR 0.11% = 2× NIFTY ref
  assert.ok(Math.abs(c.price - 54000 / NIFTY_REF.spot) < 1e-12);
  assert.ok(Math.abs(c.vol - 2) < 1e-9);
  assert.ok(Math.abs(c.lot - 30 / 65) < 1e-12);
  assert.equal(calibrationFor({ symbol: 'GOLDM', lotSize: 1 }, 120000, 120000 * 0.05).vol, 4); // capped
  assert.equal(calibrationFor({ symbol: 'GOLDM', lotSize: 1 }, 120000, 0).vol, 1); // no ATR yet
});

test('options: "clearly above VWAP" needs a bigger % move on a more volatile index', () => {
  const t = computeTechnical(fx.candles)!;
  const base = { pcr: 1.2, priceAction: 0, ema20: 101, ema50: 100, vwap: 100, spot: 100.07, leg: null, ivHistory: [] };
  assert.equal(scoreDirection('CE', base).breakdown.vwapPosition, 10); // +0.07% > 0.05%
  const cal = { base: false, price: 1, vol: 2, lot: 1 }; // twice as volatile → threshold 0.10%
  assert.equal(scoreDirection('CE', { ...base, cal }).breakdown.vwapPosition, 5);
  assert.ok(t.last.atr > 0);
});

test('MCX: VWAP and day-open thresholds follow the contract’s own volatility', () => {
  const t0 = Date.UTC(2026, 10, 4, 4, 0); // 09:30 IST
  // Steady climb: +0.3% from the day open, above VWAP, OI rising.
  const c: Candle[] = Array.from({ length: 40 }, (_, i) => {
    const p = 100 + i * 0.0077;
    return { t: t0 + i * 300_000, o: p - 0.003, h: p + 0.004, l: p - 0.006, c: p, v: 1000, oi: 5000 + i * 10 };
  });
  const tech = computeTechnical(c)!;
  const spot = c.at(-1)!.c;
  const plain = evaluateFutures(c, tech, spot).factors;
  const calm = evaluateFutures(c, tech, spot, { base: false, price: 1, vol: 2, lot: 1 }).factors; // thresholds × 2
  const f = (fs: typeof plain, k: string) => fs.find((x) => x.key === k)!.value;
  assert.equal(f(plain, 'dayOpen'), 10); // +0.30% > 0.2%
  assert.equal(f(calm, 'dayOpen'), 5); // +0.30% < 0.4%
});
