/// <reference types="node" />
/** Index screener: day stats, scoring, verdicts, warnings, ranking, and a full scan via the fake Dhan. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { createLocalApi, type LocalApi } from '../src/api/localApi.ts';
import { dayStats, rankResults, screenIndex, type ScreenResult } from '../src/lib/screener.ts';
import { computeTechnical } from '../src/lib/engine/indicators.ts';
import { DEFAULT_CONFIG, type Candle, type ChainSnapshot } from '../src/lib/engine/types.ts';
import { FAKE_CLIENT, FAKE_TOKEN, GOLDEN_EXPIRY, startFakeDhan } from './fakeDhan.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/workbook-2026-08-27.json', import.meta.url), 'utf8'));
const candles: Candle[] = fx.candles;
const chain: ChainSnapshot = fx.chain;
const at = (hh: number, mm: number, date = '2026-08-27') =>
  Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), hh, mm) - 5.5 * 3600_000;
const cfg = { ...DEFAULT_CONFIG, lastEntryTime: '14:35' };

test('day stats from the real 27 Aug candles', () => {
  const t = computeTechnical(candles)!;
  const d = dayStats(candles, t.last.vwap, t.last.atr, at(11, 40));
  assert.equal(d.prevClose, candles.filter((c) => new Date(c.t + 5.5 * 3600e3).toISOString().startsWith('2026-08-26')).at(-1)!.c);
  assert.ok(d.changePct! < 0); // NIFTY fell on 27 Aug
  assert.ok(d.high >= d.low && d.rangePts === d.high - d.low);
  assert.ok(d.avgRangePts! > 0 && d.rangeUsed! > 0);
  assert.ok(d.efficiency >= 0 && d.efficiency <= 1);
  assert.ok(d.vwapDistPct < 0); // below VWAP
});

test('real 27 Aug at 11:40: leans PE with the bearish trend, has a plan, explains itself', () => {
  const r = screenIndex('NIFTY', { candles, chain }, cfg, fx.ivHistoryBefore, at(11, 40));
  assert.equal(r.direction, 'PE');
  assert.equal(r.trend, 'BEARISH');
  assert.ok(Math.abs(r.confidence - 88.898) < 0.01);
  assert.ok(r.pros.some((p) => /agrees with PE/.test(p)));
  assert.ok(r.plan && r.plan.qty > 0 && !r.plan.blocked);
  assert.ok(['GOOD', 'CAUTION'].includes(r.verdict), r.verdict);
  assert.ok(r.score >= 45 && r.score <= 100);
  assert.match(r.summary, /^NIFTY 50 down \d+\.\d\d% on the day · (moving cleanly|choppy|mixed moves), bearish trend · below VWAP · PCR 0\.\d\d \(call writers strong\) · IV /);
});

test('after the entry cutoff, or with the market closed: NO NEW TRADES', () => {
  const late = screenIndex('NIFTY', { candles, chain }, cfg, fx.ivHistoryBefore, at(14, 40));
  assert.equal(late.verdict, 'NO NEW TRADES');
  assert.match(late.warnings[0], /Past your entry cutoff \(14:35 IST\)/);
  const closed = screenIndex('NIFTY', { candles, chain }, cfg, fx.ivHistoryBefore, at(17, 0));
  assert.equal(closed.verdict, 'NO NEW TRADES');
  assert.match(closed.warnings[0], /Market is closed/);
});

test('expiry day lowers the score and is never GOOD', () => {
  const normal = screenIndex('NIFTY', { candles, chain }, cfg, fx.ivHistoryBefore, at(11, 40));
  const exp = screenIndex('NIFTY', { candles, chain: { ...chain, expiry: '2026-08-27' } }, cfg, fx.ivHistoryBefore, at(11, 40));
  assert.equal(exp.expiryDay, true);
  assert.ok(exp.score <= normal.score - 10 || exp.score === 0);
  assert.notEqual(exp.verdict, 'GOOD');
  assert.ok(exp.warnings.some((w) => /^Expiry day/.test(w)));
});

test('a refused ENTER (premium filter) makes it AVOID', () => {
  const r = screenIndex('NIFTY', { candles, chain }, { ...cfg, minPremium: 500 }, fx.ivHistoryBefore, at(11, 40));
  assert.equal(r.verdict, 'AVOID');
  assert.ok(r.warnings.some((w) => /^ENTER would be refused: Premium/.test(w)));
});

test('ranking: tradeable verdicts first, then score', () => {
  const mk = (symbol: string, verdict: ScreenResult['verdict'], score: number) => ({ symbol, verdict, score }) as ScreenResult;
  const r = rankResults([mk('A', 'AVOID', 90), mk('B', 'CAUTION', 50), mk('C', 'GOOD', 70), mk('D', 'CAUTION', 60), mk('E', 'NO NEW TRADES', 99)]);
  assert.deepEqual(r.map((x) => x.symbol), ['C', 'D', 'B', 'A', 'E']);
});

let fake: Awaited<ReturnType<typeof startFakeDhan>>;
let api: LocalApi;
before(async () => {
  fake = await startFakeDhan();
  api = await createLocalApi({
    positionTickMs: 0,
    clientId: FAKE_CLIENT,
    accessToken: FAKE_TOKEN,
    baseUrl: fake.url,
    store: { load: async () => null, save: async () => {} },
    staticIp: () => '',
    publicIp: async () => '198.51.100.20',
    sleep: async () => {},
  });
  await api.engineConfig({ expiry: GOLDEN_EXPIRY, lastEntryTime: '' });
});
after(() => {
  api.dispose();
  fake.server.close();
});

test('phone: one scan loads NIFTY, BANK NIFTY and FIN NIFTY and reports the day', async () => {
  const n = fake.requests.length;
  const rep = await api.screener();
  const chainCalls = fake.requests.slice(n).filter((r) => r.path === '/optionchain').map((r) => r.body.UnderlyingScrip);
  assert.deepEqual(chainCalls.sort(), [13, 25, 27]);
  assert.equal(rep.results.length + rep.failed.length, 3);
  assert.ok(rep.results.length >= 1, JSON.stringify(rep.failed));
  assert.ok(rep.notes.some((x) => /No news or events data/.test(x)));
  assert.ok(rep.notes.some((x) => /^Your day: 0\/3 trades, booked ₹0\./.test(x)));
  // the engine's own settings and state are untouched by a scan
  const s = await api.engine();
  assert.equal(s.config.symbol, 'NIFTY');
  assert.equal(s.state.position, null);
});
