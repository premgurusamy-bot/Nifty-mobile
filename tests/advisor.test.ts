/// <reference types="node" />
/** Voice advisor: best index to watch, watch / skip with the reason, what happens next. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advise, type IndexInput } from '../src/lib/advisor.ts';

const cfg = { confHigh: 80, confWatch: 60 };
const trend = (over: Record<string, unknown> = {}) =>
  ({ direction: 'UP', lean: 'UP', phase: 'RUNNING', strength: 70, ageMin: 85, entry: { score: 75 }, ...over }) as never;
const idx = (over: Partial<IndexInput>): IndexInput => ({
  symbol: 'NIFTY',
  label: 'NIFTY 50',
  confidence: 82,
  signal: 'WAIT',
  direction: 'CE',
  strike: 24300,
  decision: 'SETUP HOLDING - score steady since 82.0, entry check at 10:15:30 (CE …), then break of 24,312.50',
  inTrade: false,
  trend: trend(),
  ...over,
});

test('the best index, the others watched or skipped with the reason, and what is next', () => {
  const a = advise(
    [
      idx({}),
      idx({ symbol: 'BANKNIFTY', label: 'BANK NIFTY', confidence: 72, decision: 'WATCH - CONFIRMATION BUILDING (INSIDE BAR)', trend: trend({ strength: 50 }) }),
      idx({ symbol: 'FINNIFTY', label: 'FIN NIFTY', confidence: 66, trend: trend({ direction: 'SIDEWAYS' }) }),
    ],
    cfg,
  );
  assert.equal(a.best, 'NIFTY');
  assert.deepEqual(a.items.map((i) => [i.symbol, i.verdict]), [['NIFTY', 'BEST'], ['BANKNIFTY', 'WATCH'], ['FINNIFTY', 'SKIP']]);
  assert.match(a.items[0].next, /^Setup armed: CE 24300 enters if price breaks 24,312\.50 after the hold\.$/);
  assert.match(a.items[1].next, /building towards 80/);
  assert.equal(a.items[2].reason, 'no trend, sideways');
  assert.match(a.speech, /^Best index: Nifty\. score 82, up trend for 1 hour 25 minutes, entry strength 75\. Setup armed/);
  assert.match(a.speech, /Bank Nifty: watch, score 72/);
  assert.match(a.speech, /Fin Nifty: skip, no trend, sideways\./);
  assert.match(a.headline, /^Best: NIFTY 50 — score 82/);
});

test('skips: against the trend, a tiring trend, a low score, blocked; a trade comes first; off is silent', () => {
  const a = advise(
    [
      idx({ direction: 'PE' }), // UP trend, PE setup
      idx({ symbol: 'BANKNIFTY', label: 'BANK NIFTY', trend: trend({ phase: 'EXHAUSTING' }) }),
      idx({ symbol: 'FINNIFTY', label: 'FIN NIFTY', confidence: 40, decision: 'NO TRADE (NONE)' }),
    ],
    cfg,
  );
  assert.equal(a.best, null);
  assert.ok(a.items.every((i) => i.verdict === 'SKIP'));
  assert.match(a.items.find((i) => i.symbol === 'NIFTY')!.reason, /against the up trend/);
  assert.match(a.items.find((i) => i.symbol === 'BANKNIFTY')!.reason, /tiring/);
  assert.match(a.items.find((i) => i.symbol === 'FINNIFTY')!.reason, /score only 40/);
  assert.match(a.speech, /^No index to trade right now\./);

  const t = advise([idx({ inTrade: true, tradePnl: 4200 }), idx({ symbol: 'BANKNIFTY', label: 'BANK NIFTY', off: true })], cfg);
  assert.equal(t.best, 'NIFTY');
  assert.equal(t.items[0].verdict, 'IN TRADE');
  assert.match(t.speech, /Nifty: in a CE trade, profit 4,200 rupees\. Managing the trade\./);
  assert.doesNotMatch(t.speech, /Bank Nifty/); // off: not spoken
  const b = advise([idx({ decision: 'BLOCKED - Trend filter: no trend (sideways, ADX 14) — waiting for one to form' })], cfg);
  assert.equal(b.items[0].verdict, 'SKIP');
  assert.equal(b.items[0].reason, 'Trend filter: no trend (sideways, ADX 14)');
});

test('the key changes only when the best index or a verdict changes', () => {
  const k1 = advise([idx({ confidence: 82 })], cfg).key;
  const k2 = advise([idx({ confidence: 85 })], cfg).key;
  const k3 = advise([idx({ confidence: 50 })], cfg).key;
  assert.equal(k1, k2);
  assert.notEqual(k1, k3);
});

test('the engine ships the advice with its snapshot', async () => {
  const { readFileSync } = await import('node:fs');
  const { EngineRunner } = await import('../src/lib/engine/runner.ts');
  const fx = JSON.parse(readFileSync(new URL('./fixtures/workbook-2026-08-27.json', import.meta.url), 'utf8'));
  const r = new EngineRunner({ load: async () => ({ candles: fx.candles, chain: fx.chain }), now: () => Date.UTC(2026, 7, 27, 6, 10) } as never, {
    load: async () => null,
    save: async () => {},
  });
  await r.init();
  await r.refresh();
  const a = r.snapshot().advice!;
  assert.equal(a.items.length, 1);
  assert.equal(a.items[0].symbol, 'NIFTY');
  assert.ok(a.speech.length > 10);
});
