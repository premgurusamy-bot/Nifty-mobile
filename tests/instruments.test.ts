/// <reference types="node" />
/**
 * Multi-instrument support: catalog switching (BANKNIFTY / FINNIFTY options,
 * MCX mini futures), MCX hours, futures plans and short-side position
 * management, contract resolution from Dhan's instrument list, and live MCX
 * orders (lots, sides, stop on the correct side, tick rounding) via the fake Dhan.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { parseMcxFutures, pickCurrentContract } from '../server/contracts.ts';
import { stopLimitPrice } from '../server/liveTrader.ts';
import { createLocalApi, type LocalApi } from '../src/api/localApi.ts';
import { catalogEntry, mcxCloseMinutes, sessionOpen } from '../src/lib/engine/catalog.ts';
import { checkAndCloseIfHit } from '../src/lib/engine/decision.ts';
import { buildFuturesPlan, evaluateFutures, oiBuildup } from '../src/lib/engine/futures.ts';
import { computeTechnical } from '../src/lib/engine/indicators.ts';
import { EngineRunner, sanitizeConfig } from '../src/lib/engine/runner.ts';
import { DEFAULT_CONFIG, initialEngineState, type Candle, type OpenPosition } from '../src/lib/engine/types.ts';
import { displayName, lotSize, optionId, parseOptionId } from '../src/lib/instruments.ts';
import { FAKE_CLIENT, FAKE_TOKEN, MCX_CONTRACTS, startFakeDhan } from './fakeDhan.ts';

const ist = (date: string, hh: number, mm: number) =>
  Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), hh, mm) - 5.5 * 3600_000;

test('switching instrument loads its full settings; unknown symbols are refused', () => {
  const g = sanitizeConfig({ symbol: 'GOLDM' }, DEFAULT_CONFIG);
  assert.deepEqual(
    [g.instrumentKind, g.tradeSegment, g.lotSize, g.pointValue, g.tickSize, g.session, g.maxLots, g.futSecurityId],
    ['MCX_FUTURES', 'MCX_COMM', 1, 10, 1, 'MCX', 1, ''],
  );
  const b = sanitizeConfig({ symbol: 'BANKNIFTY' }, g);
  assert.deepEqual(
    [b.instrumentKind, b.underlyingSecurityId, b.strikeInterval, b.lotSize, b.tradeSegment, b.session],
    ['INDEX_OPTIONS', 25, 100, 30, 'NSE_FNO', 'NSE'],
  );
  assert.equal(sanitizeConfig({ symbol: 'FINNIFTY' }, b).underlyingSecurityId, 27);
  assert.throws(() => sanitizeConfig({ symbol: 'COPPERX' }, DEFAULT_CONFIG), /Unknown instrument/);
  // Your edits to the selected instrument's values are kept.
  assert.equal(sanitizeConfig({ lotSize: 35 }, b).lotSize, 35);
});

test('option ids, labels and lot sizes per index', () => {
  const id = optionId({ underlying: 'BANKNIFTY', expiry: '2026-11-25', strike: 54000, type: 'PE' });
  assert.equal(parseOptionId(id)!.underlying, 'BANKNIFTY');
  assert.equal(displayName(id), 'BANKNIFTY 25 NOV 54000 PE');
  assert.equal(lotSize(id), 30);
  assert.equal(lotSize(optionId({ underlying: 'FINNIFTY', expiry: '2026-11-25', strike: 25500, type: 'CE' })), 60);
});

test('MCX hours: 09:00 to 23:55 IST in US winter, 23:30 in US summer; NSE unchanged', () => {
  assert.equal(mcxCloseMinutes(ist('2026-11-04', 12, 0)), 23 * 60 + 55);
  assert.equal(mcxCloseMinutes(ist('2026-07-15', 12, 0)), 23 * 60 + 30);
  assert.equal(sessionOpen(ist('2026-11-04', 23, 40), 'MCX'), true);
  assert.equal(sessionOpen(ist('2026-07-15', 23, 40), 'MCX'), false);
  assert.equal(sessionOpen(ist('2026-11-04', 8, 59), 'MCX'), false);
  assert.equal(sessionOpen(ist('2026-11-07', 12, 0), 'MCX'), false); // Saturday
  assert.equal(sessionOpen(ist('2026-11-04', 9, 5), 'NSE'), false);
  assert.equal(sessionOpen(ist('2026-11-04', 16, 0), 'NSE'), false);
});

test('futures plan: ATR risk on the tick, lots by ₹ per point, capped; SHORT mirrors LONG', () => {
  const cfg = { ...sanitizeConfig({ symbol: 'GOLDM' }, DEFAULT_CONFIG), maxLots: 0 };
  const L = buildFuturesPlan('LONG', 120000, 40, cfg)!;
  assert.deepEqual([L.riskPts, L.sl, L.target1, L.target2, L.qty, L.maxLoss], [60, 119940, 120120, 120180, 3, 1800]);
  const S = buildFuturesPlan('SHORT', 120000, 40, cfg)!;
  assert.deepEqual([S.sl, S.target1, S.target2], [120060, 119880, 119820]);
  assert.equal(buildFuturesPlan('LONG', 120000, 40, { ...cfg, maxLots: 1 })!.qty, 1);
  const lead = buildFuturesPlan('SHORT', 180.03, 0.21, sanitizeConfig({ symbol: 'LEADMINI' }, DEFAULT_CONFIG))!;
  assert.equal(lead.riskPts, 0.3); // 0.315 → 0.30 on the 0.05 tick
  assert.equal(lead.maxLoss, 300); // 0.30 × ₹1,000 × 1 lot
});

const shortPos = (over: Partial<OpenPosition> = {}): OpenPosition => ({
  direction: 'SHORT',
  strike: 0,
  entry: 120000,
  originalSl: 120060,
  target1: 119880,
  target2: 119820,
  totalQty: 2,
  journalId: 'J1',
  openedAt: 0,
  partialBooked: false,
  partialQty: 0,
  partialPnl: 0,
  remainingQty: 2,
  currentSl: 120060,
  side: -1,
  pointValue: 10,
  symbol: 'GOLDM',
  ...over,
});
const withPos = (p: OpenPosition) => ({
  ...initialEngineState(),
  day: '2026-11-04',
  position: p,
  journal: [
    {
      id: 'J1',
      symbol: 'GOLDM',
      date: '2026-11-04',
      time: '10:00:00',
      spot: 120000,
      strike: 0,
      direction: 'SHORT' as const,
      entry: 120000,
      sl: 120060,
      target: 119880,
      exit: null,
      pnl: null,
      confidence: 85,
      trend: 'BEARISH',
      pcr: 0,
      oiBias: 'SHORT BUILDUP',
      iv: 0,
      delta: 0,
      entryReason: '',
      exitReason: '',
    },
  ],
});
const goldCfg = sanitizeConfig({ symbol: 'GOLDM' }, DEFAULT_CONFIG);

test('short futures: a RISING price hits the stop; ₹ P&L = −(exit−entry) × lots × ₹/point', () => {
  const s = withPos(shortPos());
  assert.equal(checkAndCloseIfHit(s, 119990, goldCfg, 1), false); // in profit, nothing to do
  assert.ok(checkAndCloseIfHit(s, 120075, goldCfg, 2));
  assert.equal(s.position, null);
  assert.equal(s.journal[0].pnl, -(120060 - 120000) * 2 * 10); // −₹1,200
  assert.equal(s.realizedToday, -1200);
});

test('short futures: a FALLING price books half at T1, trails to breakeven, T2 closes the rest', () => {
  const s = withPos(shortPos());
  assert.ok(checkAndCloseIfHit(s, 119875, goldCfg, 1));
  assert.deepEqual([s.position!.partialQty, s.position!.remainingQty, s.position!.currentSl], [1, 1, 120000]);
  assert.equal(s.position!.partialPnl, 120 * 1 * 10);
  assert.ok(checkAndCloseIfHit(s, 119800, goldCfg, 2));
  assert.equal(s.journal[0].pnl, 1200 + 180 * 10);
});

test('contract resolution: detailed and compact CSVs, nearest expiry ≥ roll cutoff', () => {
  const detailed = [
    'EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,UNDERLYING_SYMBOL,SYMBOL_NAME,SM_EXPIRY_DATE,TICK_SIZE',
    'MCX,M,1001,FUTCOM,GOLDM,GOLDM-Nov2026-FUT,2026-11-05 23:59:00,1',
    'MCX,M,1002,FUTCOM,GOLDM,GOLDM-Dec2026-FUT,2026-12-04 23:59:00,1',
    'MCX,M,1003,OPTFUT,GOLDM,GOLDM-Dec2026-120000-CE,2026-11-25 23:59:00,0.5',
    'MCX,M,1004,FUTCOM,GOLD,GOLD-Dec2026-FUT,2026-12-04 23:59:00,1',
  ].join('\n');
  const rows = parseMcxFutures(detailed, 'GOLDM');
  assert.deepEqual(
    rows.map((r) => r.securityId),
    ['1001', '1002'],
  );
  assert.equal(pickCurrentContract(rows, ist('2026-11-01', 12, 0), 3)!.securityId, '1001');
  assert.equal(
    pickCurrentContract(rows, ist('2026-11-03', 12, 0), 3)!.securityId,
    '1002',
    'rolls 3 days before expiry',
  );
  const compact = [
    'SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_EXPIRY_CODE,SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,SEM_OPTION_TYPE,SEM_TICK_SIZE,SEM_EXPIRY_FLAG',
    'MCX,M,2001,FUTCOM,0,LEADMINI-Nov2026-FUT,1.0,LEADMINI NOV FUT,2026-11-28 23:59:00,0,XX,0.05,M',
  ].join('\n');
  const lead = parseMcxFutures(compact, 'LEADMINI');
  assert.deepEqual([lead[0].securityId, lead[0].tickSize, lead[0].expiry], ['2001', 0.05, '2026-11-28']);
});

test('futures model: falling price with rising OI reads SHORT BUILDUP and favours SHORT', () => {
  const c: Candle[] = [];
  let p = 120000;
  for (let i = 0; i < 120; i++) {
    const o = p;
    const cl = o - 30 - (i % 5) * 4;
    c.push({
      t: ist('2026-11-04', 9, 0) + i * 300_000,
      o,
      h: o + 10,
      l: cl - 10,
      c: cl,
      v: 1000 + (i === 119 ? 3000 : 0),
      oi: 20000 + i * 50,
    });
    p = cl;
  }
  const tech = computeTechnical(c)!;
  const ev = evaluateFutures(c, tech, c.at(-1)!.c);
  assert.equal(ev.buildup, 'SHORT BUILDUP');
  assert.equal(ev.direction, 'SHORT');
  assert.ok(ev.scoreShort > ev.scoreLong);
  assert.equal(
    ev.factors.reduce((a, f) => a + f.max, 0),
    100,
  );
  assert.equal(oiBuildup(c.map((x) => ({ ...x, oi: undefined }))).label, 'NO OI DATA');
});

test('switching instrument is blocked while a position is open, and IV histories are kept per instrument', async () => {
  const r = new EngineRunner(
    {
      load: async () => {
        throw new Error('unused');
      },
    },
    { load: async () => null, save: async () => {} },
  );
  r.state = { ...r.state, ivHistory: [9, 10, 11] };
  await r.updateConfig({ symbol: 'BANKNIFTY' });
  assert.deepEqual(r.state.ivHistory, []);
  assert.deepEqual(r.state.ivBank!.NIFTY, [9, 10, 11]);
  await r.updateConfig({ symbol: 'NIFTY' });
  assert.deepEqual(r.state.ivHistory, [9, 10, 11]);
  r.state = { ...r.state, position: shortPos() };
  await assert.rejects(r.updateConfig({ symbol: 'GOLDM' }), /Exit the open position/);
});

test('stop-limit prices sit beyond the trigger on the correct side', () => {
  assert.equal(stopLimitPrice(70.96), 67.4); // option sell stop (unchanged)
  assert.equal(stopLimitPrice(120060, { side: -1, tick: 1, futures: true }), 120180); // short's BUY stop: above
  assert.equal(stopLimitPrice(119940, { side: 1, tick: 1, futures: true }), 119820); // long's SELL stop: below
  assert.equal(stopLimitPrice(180.3, { side: -1, tick: 0.05, futures: true }), 180.55); // 5 ticks min
});

// ---- Live MCX futures through the phone API, against the fake Dhan ------------------

let fake: Awaited<ReturnType<typeof startFakeDhan>>;
let api: LocalApi;
const sent = () => fake.requests.filter((r) => r.method === 'POST' && r.path === '/orders').map((r) => r.body);

before(async () => {
  fake = await startFakeDhan();
  fake.state.ips.primary = '203.0.113.7';
  api = await createLocalApi({
    clientId: FAKE_CLIENT,
    accessToken: FAKE_TOKEN,
    baseUrl: fake.url,
    store: { load: async () => null, save: async () => {} },
    staticIp: () => '203.0.113.7',
    publicIp: async () => '203.0.113.7',
    sleep: async () => {},
  });
});
after(() => {
  api.dispose();
  fake.server.close();
});

test('MCX live: Gold Mini contract auto-resolves, SHORT entry sells N lots on MCX_COMM with a BUY stop above, EXIT buys back', async () => {
  await api.engineConfig({ symbol: 'GOLDM', maxRisk: 100000, maxLots: 2 });
  let s = await api.engineRefresh();
  assert.equal(s.status, 'Ready', s.status);
  const expected = MCX_CONTRACTS.filter(
    (c) =>
      c.symbol === 'GOLDM' &&
      c.expiry >= new Date(Date.now() + 5.5 * 3600_000 + 3 * 86400_000).toISOString().slice(0, 10),
  )[0];
  assert.equal(s.config.futSecurityId, expected.id);
  assert.equal(s.config.futTradingSymbol, expected.trading);
  const candle = fake.requests.filter((r) => r.path === '/charts/intraday').at(-1)!;
  assert.deepEqual([candle.body.exchangeSegment, candle.body.instrument, candle.body.oi], ['MCX_COMM', 'FUTCOM', true]);
  assert.equal(s.dashboard!.futures!.buildup, 'SHORT BUILDUP');
  const plan = s.dashboard!.candidatePlan!;
  assert.equal(plan.direction, 'SHORT');
  assert.equal(plan.qty, 2, 'capped at max lots');
  assert.equal(s.dashboard!.factors.length, 9);

  // Live (pre-flight must pass first).
  const r = await api.setTradeMode('LIVE');
  assert.equal(r.preflight!.ok, true, JSON.stringify(r.preflight!.items.filter((i) => i.status !== 'pass')));
  assert.ok(r.preflight!.items.find((i) => i.id === 'symbol')!.detail.includes('qty in lots'));

  const n0 = sent().length;
  s = await api.engineEnter();
  const [entry, stop] = sent().slice(n0);
  assert.deepEqual(
    [entry.exchangeSegment, entry.transactionType, entry.orderType, entry.quantity, entry.securityId],
    ['MCX_COMM', 'SELL', 'MARKET', 2, expected.id],
  );
  const pos = s.state.position!;
  assert.equal(pos.side, -1);
  assert.ok(pos.currentSl > pos.entry, 'short stop above entry');
  assert.deepEqual(
    [stop.transactionType, stop.orderType, stop.quantity, stop.exchangeSegment],
    ['BUY', 'STOP_LOSS', 2, 'MCX_COMM'],
  );
  assert.equal(stop.triggerPrice, Math.round(pos.currentSl), 'trigger on the ₹1 tick');
  assert.ok(stop.price > stop.triggerPrice, 'buy-stop limit above its trigger');

  s = await api.engineExit();
  const exit = sent().at(-1);
  assert.deepEqual([exit.transactionType, exit.orderType, exit.quantity], ['BUY', 'MARKET', 2]);
  const j = s.state.journal.at(-1)!;
  assert.equal(j.symbol, 'GOLDM');
  assert.equal(j.direction, 'SHORT');
  // Short P&L: (entry − exit) × lots × ₹10.
  assert.ok(Math.abs(j.pnl! - (pos.entry - j.exit!) * 2 * 10) < 1e-6);

  await api.setTradeMode('PAPER');
  await assert.rejects(api.optionChain('2026-11-25'), /traded as a future/);
});

test('fixture sanity: the golden NIFTY data still drives NIFTY', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/workbook-2026-08-27.json', import.meta.url), 'utf8'));
  assert.equal(fx.candles.length, 225);
  assert.equal(catalogEntry('NIFTY')!.underlyingSecurityId, 13);
});
