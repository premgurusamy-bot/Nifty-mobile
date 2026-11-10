/// <reference types="node" />
/** Market breadth (advances / declines from the index stocks) and the pre-market report. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { advise, type IndexInput } from '../src/lib/advisor.ts';
import { breadthFit, builtInIds, computeBreadth, NIFTY50_STOCKS, parseEquityIds, type StockQuote } from '../src/lib/breadth.ts';
import { EngineRunner } from '../src/lib/engine/runner.ts';
import { DEFAULT_CONFIG, initialEngineState, type Candle, type ChainSnapshot } from '../src/lib/engine/types.ts';
import { preMarketPhase, preMarketReport, preMarketWindow } from '../src/lib/premarket.ts';
import { breadthFeed } from '../server/breadthSource.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/workbook-2026-08-27.json', import.meta.url), 'utf8'));
const candles: Candle[] = fx.candles;
const chain: ChainSnapshot = fx.chain;
const ist = (d: string) => Date.parse(`${d}+05:30`);

/** Every NIFTY 50 stock: the first `up` of them up `upPct`%, the rest down `dnPct`%. */
const quotes = (up: number, upPct = 1, dnPct = -1): StockQuote[] =>
  NIFTY50_STOCKS.map((s, i) => ({ symbol: s.symbol, prevClose: 1000, ltp: 1000 * (1 + (i < up ? upPct : dnPct) / 100) }));
// The same, but with the heavyweights (start of the list) last.
const quotesSmallUp = (up: number): StockQuote[] =>
  [...NIFTY50_STOCKS].reverse().map((s, i) => ({ symbol: s.symbol, prevClose: 1000, ltp: i < up ? 1010 : 990 }));

test('advances / declines, the weighted move and the level', () => {
  const b = computeBreadth('NIFTY', quotes(45), 0)!;
  assert.equal(b.advances, 45);
  assert.equal(b.declines, NIFTY50_STOCKS.length - 45);
  assert.equal(b.level, 'STRONG UP');
  assert.ok(b.weightedPct > 0.5);
  assert.equal(b.up[0].symbol, 'HDFCBANK'); // the heaviest pushes most
  assert.match(b.text, /^Nifty 50 stocks: 45 up, \d+ down · weighted \+/);

  assert.equal(computeBreadth('NIFTY', quotes(5), 0)!.level, 'STRONG DOWN');
  const d = computeBreadth('NIFTY', quotes(20, 0.2, -1), 0)!;
  assert.equal(d.level, 'DOWN');
  const m = computeBreadth('NIFTY', quotes(27), 0)!;
  assert.equal(m.level, 'MIXED');
  // Most stocks up, but the heavyweights down: the index falls — a narrow move.
  const n = computeBreadth('NIFTY', quotesSmallUp(35), 0)!;
  assert.ok(n.advances > n.declines && n.weightedPct < -0.15, n.text);
  assert.equal(n.narrow, true);
  assert.equal(computeBreadth('NIFTY', quotes(10).slice(0, 3), 0), null); // too few prices
});

test('breadth with / against a trade side', () => {
  const strongDown = computeBreadth('NIFTY', quotes(0), 0)!;
  assert.equal(breadthFit(strongDown, 'up').fit, 'STRONG AGAINST');
  assert.equal(breadthFit(strongDown, 'down').fit, 'WITH');
  assert.equal(breadthFit(computeBreadth('NIFTY', quotes(15), 0), 'up').fit, 'AGAINST');
  assert.equal(breadthFit(null, 'up').fit, 'NEUTRAL');
});

test('advisor: a CE setup with breadth strongly down is skipped; breadth with it ranks higher', () => {
  const trend = { direction: 'UP', lean: 'UP', phase: 'RUNNING', strength: 70, ageMin: 85, entry: { score: 75 } } as never;
  const base: IndexInput = { symbol: 'NIFTY', label: 'NIFTY 50', confidence: 82, signal: 'WAIT', direction: 'CE', strike: 24300, decision: 'WATCH', inTrade: false, trend };
  const cfg = { confHigh: 80, confWatch: 60 };
  const skip = advise([{ ...base, breadth: computeBreadth('NIFTY', quotes(2), 0) }], cfg).items[0];
  assert.equal(skip.verdict, 'SKIP');
  assert.match(skip.reason, /breadth 2 up \d+ down, against the CE setup/);
  const withIt = advise([{ ...base, breadth: computeBreadth('NIFTY', quotes(45), 0) }], cfg).items[0];
  const none = advise([base], cfg).items[0];
  assert.equal(withIt.verdict, 'BEST');
  assert.ok(withIt.rank > none.rank);
  assert.match(withIt.reason, /breadth 45 up/);
  assert.match(withIt.breadthText, /^Nifty 50 stocks/);
});

test('stock ids from Dhan’s NSE equity list (EQ series only), built-in heavyweights otherwise', () => {
  const csv = [
    'EXCH_ID,SEGMENT,SECURITY_ID,ISIN,INSTRUMENT,UNDERLYING_SECURITY_ID,UNDERLYING_SYMBOL,SYMBOL_NAME,SERIES',
    'NSE,E,2885,INE002A01018,EQUITY,,RELIANCE,RELIANCE INDUSTRIES LTD,EQ',
    'NSE,E,99999,INE002A01018,EQUITY,,RELIANCE,RELIANCE INDUSTRIES LTD,BE',
    'NSE,E,2031,INE101A01026,EQUITY,,M&M,MAHINDRA & MAHINDRA LTD,EQ',
    'BSE,E,500325,INE002A01018,EQUITY,,RELIANCE,RELIANCE INDUSTRIES LTD,A',
  ].join('\n');
  const m = parseEquityIds(csv, new Set(['RELIANCE', 'M&M', 'TCS']));
  assert.deepEqual([...m.entries()], [['RELIANCE', '2885'], ['M&M', '2031']]);
  assert.equal(builtInIds().get('HDFCBANK'), '1333');
});

test('breadth feed: one Dhan quote call for the basket; Angel One when Dhan fails', async () => {
  const calls: any[] = [];
  const dhan = {
    quote: async (b: any) => {
      calls.push(b);
      if (calls.length > 1) throw new Error('DH-904 rate limit');
      const data: any = { NSE_EQ: {} };
      for (const id of b.NSE_EQ) data.NSE_EQ[String(id)] = { last_price: 110, net_change: 10, ohlc: { close: 100 } };
      return { data };
    },
    instrumentCsv: async () => {
      throw new Error('offline');
    },
  } as never;
  const angelCalls: any[] = [];
  const angel = {
    connected: true,
    quote: async (_mode: string, ex: any) => {
      angelCalls.push(ex);
      return ex.NSE.map((t: string) => ({ symbolToken: t, ltp: 95, close: 100 }));
    },
  } as never;
  const feed = breadthFeed(dhan, angel);
  const q = await feed('NIFTY');
  assert.equal(calls.length, 1);
  assert.equal(q.length, [...builtInIds().keys()].filter((s) => NIFTY50_STOCKS.some((x) => x.symbol === s)).length);
  assert.deepEqual(q[0], { symbol: 'HDFCBANK', ltp: 110, prevClose: 100 });
  const viaAngel = await feed('BANKNIFTY');
  assert.equal(angelCalls.length, 1);
  assert.ok(viaAngel.every((x) => x.ltp === 95));
});

test('pre-market window and phases (IST, weekdays)', () => {
  assert.equal(preMarketWindow(ist('2026-08-28T08:29:00')), false);
  assert.equal(preMarketWindow(ist('2026-08-28T08:30:00')), true);
  assert.equal(preMarketWindow(ist('2026-08-28T09:14:59')), true);
  assert.equal(preMarketWindow(ist('2026-08-28T09:15:00')), false);
  assert.equal(preMarketWindow(ist('2026-08-29T08:45:00')), false); // Saturday
  assert.equal(preMarketPhase(ist('2026-08-28T08:45:00')), 'BEFORE');
  assert.equal(preMarketPhase(ist('2026-08-28T09:09:00')), 'PREOPEN');
});

test('pre-market report: yesterday’s levels before 9:00; the gap and breadth from the pre-open', () => {
  const opts = { gapGuard: true, gapGuardPct: 0.5 };
  const yClose = candles[candles.length - 1].c;
  const before = preMarketReport([{ symbol: 'NIFTY', label: 'NIFTY 50', candles, spot: yClose }], ist('2026-08-28T08:35:00'), opts);
  assert.equal(before.phase, 'BEFORE');
  const i = before.items[0];
  assert.equal(i.prevClose, yClose);
  assert.equal(i.gapPct, null); // no pre-open prices yet
  assert.ok(i.prevHigh >= i.prevClose && i.prevLow <= i.prevClose);
  assert.ok(Math.abs(i.pivot - (i.prevHigh + i.prevLow + i.prevClose) / 3) < 1e-9);
  assert.match(before.speech, /^Pre-market report\. Nifty: .* No orders before 9:15\.$/);

  // 9:09: the index's pre-open price 0.8% lower, most stocks down → leans down, the gap guard waits.
  const down = computeBreadth('NIFTY', quotes(8, 0.3, -0.9), ist('2026-08-28T09:09:00'));
  const pre = preMarketReport([{ symbol: 'NIFTY', label: 'NIFTY 50', candles, spot: yClose * 0.992, breadth: down }], ist('2026-08-28T09:09:00'), opts);
  const p = pre.items[0];
  assert.equal(pre.phase, 'PREOPEN');
  assert.equal(p.gapFrom, 'INDEX');
  assert.ok(Math.abs(p.gapPct! + 0.8) < 1e-6);
  assert.ok(p.signs.includes('gap down 0.80%'));
  assert.ok(p.score <= p.signs.length);
  assert.match(p.plan, /^Big gap: the gap guard waits until 9:30/);
  assert.notEqual(pre.key, before.key);

  // The index price not updated yet (equal to the close) while the stocks moved: the gap from the stocks.
  const up = computeBreadth('NIFTY', quotes(48, 0.6, -0.2), ist('2026-08-28T09:09:00'));
  const st = preMarketReport([{ symbol: 'NIFTY', label: 'NIFTY 50', candles, spot: yClose, breadth: up }], ist('2026-08-28T09:09:00'), opts).items[0];
  assert.equal(st.gapFrom, 'STOCKS');
  assert.ok(st.gapPct! > 0.3);
});

test('runner: from 8:30 it builds the pre-market report (no engine cycle, no order); breadth once a minute', async () => {
  let now = ist('2026-08-28T08:40:00');
  let loads = 0;
  const r = new EngineRunner(
    {
      load: async () => {
        loads++;
        return { candles, chain };
      },
      now: () => now,
    },
    { load: async () => ({ state: initialEngineState(), config: { ...DEFAULT_CONFIG, watchSymbols: [] } }), save: async () => {} },
  );
  await r.init();
  let feeds = 0;
  r.breadthSource = async () => {
    feeds++;
    return quotes(40);
  };
  await r.refreshPreMarket();
  assert.equal(loads, 1);
  assert.equal(feeds, 1);
  assert.equal(r.state.position, null);
  assert.equal(r.lastRefresh, null); // no engine cycle
  const snap = r.snapshot();
  assert.equal(snap.preMarket?.phase, 'BEFORE');
  assert.equal(snap.breadth?.NIFTY?.advances, 40);
  await r.refreshPreMarket(); // within the minute: nothing new
  assert.equal(loads, 1);
  await r.refreshBreadth(); // also within the minute
  assert.equal(feeds, 1);
  // Advice carries the breadth (fresh) once there is a dashboard; switched off, none.
  await r.updateConfig({ breadth: false });
  assert.equal(r.snapshot().breadth, undefined);
  assert.equal(r.breadthFor('NIFTY'), null);
  // Next day the old report is not shown.
  now += 86400_000;
  assert.equal(r.snapshot().preMarket, null);
});
