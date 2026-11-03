/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blackScholes, normCdf } from '../src/lib/blackScholes.ts';
import { buildChain, atmStrike } from '../src/lib/optionChain.ts';
import { marketStatus, nextWeeklyExpiry, istToEpoch } from '../src/lib/time.ts';
import { createSim, stepSim, mulberry32, HISTORY_LEN } from '../src/lib/simulator.ts';
import { NIFTY_ID, displayName, parseOptionId, optionId } from '../src/lib/instruments.ts';
import { formatINR, formatNumber } from '../src/lib/format.ts';

test('normCdf sanity', () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-3);
});

test('put-call parity holds', () => {
  const base = { spot: 26000, strike: 26100, t: 7 / 365, iv: 0.12, r: 0.065 };
  const c = blackScholes({ ...base, type: 'CE' }).price;
  const p = blackScholes({ ...base, type: 'PE' }).price;
  const parity = base.spot - base.strike * Math.exp(-base.r * base.t);
  assert.ok(Math.abs(c - p - parity) < 1e-6);
});

test('option chain is centred on ATM and monotonic', () => {
  const now = istToEpoch('2026-11-03', 11, 0);
  const rows = buildChain(26012, '2026-11-10', now, 5);
  assert.equal(rows.length, 11);
  assert.equal(rows[5].strike, atmStrike(26012));
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].ce.ltp <= rows[i - 1].ce.ltp, 'calls get cheaper as strike rises');
    assert.ok(rows[i].pe.ltp >= rows[i - 1].pe.ltp, 'puts get dearer as strike rises');
  }
});

test('IST market hours', () => {
  assert.equal(marketStatus(istToEpoch('2026-11-03', 10, 0)), 'OPEN'); // Tuesday
  assert.equal(marketStatus(istToEpoch('2026-11-03', 9, 5)), 'PRE_OPEN');
  assert.equal(marketStatus(istToEpoch('2026-11-03', 15, 30)), 'CLOSED');
  assert.equal(marketStatus(istToEpoch('2026-11-07', 11, 0)), 'CLOSED'); // Saturday
});

test('weekly expiry is the next Tuesday', () => {
  assert.equal(nextWeeklyExpiry(istToEpoch('2026-11-03', 10, 0)), '2026-11-03');
  assert.equal(nextWeeklyExpiry(istToEpoch('2026-11-03', 16, 0)), '2026-11-10');
  assert.equal(nextWeeklyExpiry(istToEpoch('2026-11-05', 10, 0)), '2026-11-10');
});

test('simulator is deterministic and bounded history', () => {
  const a = createSim(42);
  const b = createSim(42);
  assert.deepEqual(a.quotes, b.quotes);
  assert.equal(a.history[NIFTY_ID].length, HISTORY_LEN);
  const next = stepSim(a, mulberry32(1));
  assert.equal(next.history[NIFTY_ID].length, HISTORY_LEN);
  assert.ok(next.quotes[NIFTY_ID].ltp > 20000 && next.quotes[NIFTY_ID].ltp < 32000);
});

test('option id round-trip and labels', () => {
  const c = { underlying: 'NIFTY' as const, expiry: '2026-11-10', strike: 26000, type: 'CE' as const };
  assert.deepEqual(parseOptionId(optionId(c)), c);
  assert.equal(displayName(optionId(c)), 'NIFTY 10 NOV 26000 CE');
  assert.equal(parseOptionId('NSE:RELIANCE'), null);
});

test('Indian number formatting', () => {
  assert.equal(formatNumber(1234567.891), '12,34,567.89');
  assert.equal(formatINR(-999.5), '-₹999.50');
  assert.equal(formatNumber(100, 0), '100');
});
