/// <reference types="node" />
/**
 * Multi-index engine: NIFTY + BANK NIFTY watched together — own setups / holds / IV / trades, one
 * shared account; both may be in a trade at once (same-cycle entries: higher score first = trade 1),
 * SPLIT / FULL size, shared limits, the active index follows the trade.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EngineRunner, sanitizeConfig } from '../src/lib/engine/runner.ts';
import { DEFAULT_CONFIG, type Candle, type ChainSnapshot, type EngineConfig } from '../src/lib/engine/types.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/workbook-2026-08-27.json', import.meta.url), 'utf8'));
const t0 = Date.UTC(2026, 7, 27, 6, 10, 0); // 11:40 IST
const min = 60_000;

/** The 27 Aug market scaled to another index's price level; peFactor tilts PCR (and so the score). */
function market(k: number, step: number, peFactor = 1, broken = false) {
  let candles: Candle[] = fx.candles.map((c: Candle) => ({ ...c, o: c.o * k, h: c.h * k, l: c.l * k, c: c.c * k }));
  if (broken) {
    const last = candles[candles.length - 1];
    candles = [...candles.slice(0, -1), { ...last, l: last.l - 30 * k }]; // breaks a PE trigger
  }
  const strikes = fx.chain.strikes.map((s: any) => {
    const leg = (l: any, f = 1) => l && { ...l, ltp: l.ltp * k, theta: l.theta * k, gamma: l.gamma / k, vega: l.vega * k, oi: l.oi * f };
    return { strike: Math.round((s.strike * k) / step) * step, ce: leg(s.ce), pe: leg(s.pe, peFactor) };
  });
  return { candles, chain: { ...fx.chain, spot: fx.chain.spot * k, strikes } as ChainSnapshot };
}

function setup(over: Partial<EngineConfig> = {}) {
  let now = t0;
  const view: Record<string, { brk: boolean }> = { NIFTY: { brk: false }, BANKNIFTY: { brk: false } };
  const loads: string[] = [];
  const source = {
    load: async (cfg: EngineConfig) => {
      loads.push(cfg.symbol);
      if (cfg.symbol === 'NIFTY') return market(1, 50, 1, view.NIFTY.brk);
      if (cfg.symbol === 'BANKNIFTY') return market(2.23, 100, 1.3, view.BANKNIFTY.brk); // a few points weaker
      throw new Error(`no data for ${cfg.symbol}`);
    },
    now: () => now,
  };
  const r = new EngineRunner(source as never, { load: async () => null, save: async () => {} });
  const ready = (async () => {
    await r.init();
    await r.updateConfig({ multiIndex: true, watchSymbols: ['NIFTY', 'BANKNIFTY'], lastEntryTime: '', dayPlanLock: false, ...over });
  })();
  return { r, view, loads, ready, at: (ms: number) => (now = t0 + ms) };
}

test('settings: off by default; index options only', () => {
  assert.deepEqual([DEFAULT_CONFIG.multiIndex, DEFAULT_CONFIG.watchSymbols], [false, ['NIFTY', 'BANKNIFTY', 'FINNIFTY']]);
  assert.throws(() => sanitizeConfig({ watchSymbols: ['NIFTY', 'GOLDM'] }, DEFAULT_CONFIG), /index options only/);
  assert.throws(() => sanitizeConfig({ watchSymbols: [] }, DEFAULT_CONFIG), /at least one/);
  assert.equal('watchOnly' in sanitizeConfig({ watchOnly: 'x' } as never, DEFAULT_CONFIG), false); // never saved
});

test('both indexes are loaded and scored each refresh, each with its own setup and IV history', async () => {
  const { r, loads, ready } = setup();
  await ready;
  await r.refresh();
  assert.deepEqual(loads, ['NIFTY', 'BANKNIFTY']);
  const w = r.snapshot().watch!;
  assert.deepEqual(w.map((x) => x.symbol), ['NIFTY', 'BANKNIFTY']);
  assert.ok(w[0].confidence! > w[1].confidence!, `${w[0].confidence} vs ${w[1].confidence}`);
  assert.match(w[0].decision, /^SETUP ARMED/);
  assert.match(w[1].decision, /^SETUP ARMED/);
  const ws = r.state.watch!;
  assert.ok(ws.NIFTY.pending && ws.BANKNIFTY.pending);
  assert.notEqual(ws.NIFTY.pending!.trigger, ws.BANKNIFTY.pending!.trigger); // their own levels
  assert.equal(ws.NIFTY.ivHistory.length, 1); // one IV snapshot each, kept apart
  assert.equal(ws.BANKNIFTY.ivHistory.length, 1);
  assert.equal(r.config.symbol, 'NIFTY'); // the active one = the higher score
});

/** Arm both, hold 3 min, both break: both confirm in the same cycle. */
async function bothBreak(over: Partial<EngineConfig> = {}) {
  const t = setup(over);
  await t.ready;
  await t.r.refresh(); // arm both
  t.at(1 * min);
  await t.r.refresh();
  t.view.NIFTY.brk = t.view.BANKNIFTY.brk = true;
  t.at(3 * min); // both held 3 min, both break
  await t.r.refresh();
  return t;
}
const lotsOf = (p: { totalQty: number }, lot: number) => p.totalQty / lot;

test('both qualify in the same cycle → both enter at once; higher score is trade 1, sizes split', async () => {
  const { r } = await bothBreak({ dayPlanLock: true, sizingMode: 'FIXED', fixedLots: 4 });
  const w = r.state.watch!;
  const nifty = r.state.position!;
  const bank = w.BANKNIFTY.position!;
  assert.equal(nifty.symbol, 'NIFTY'); // the Dashboard shows the first (higher score) one
  assert.equal(bank.symbol, 'BANKNIFTY');
  assert.equal(r.state.tradesToday, 2);
  assert.deepEqual(r.state.journal.map((j) => j.symbol), ['NIFTY', 'BANKNIFTY']); // higher score first
  assert.equal(nifty.dayPlan, 'FIRST'); // trade 1 of the day plan
  assert.equal(bank.dayPlan, 'NORMAL'); // trade 2 with nothing booked yet → the normal profit lock
  assert.equal(lotsOf(nifty, 65), 2); // SPLIT: 4 lots ÷ 2 trades
  assert.equal(lotsOf(bank, 30), 2);
  const items = r.snapshot().watch!;
  assert.deepEqual(items.map((x) => x.inTrade), [true, true]);
  assert.equal(items[1].trade!.qty, bank.remainingQty);
  assert.equal(r.snapshot().live.othersCount, 1);
});

test('FULL size: each simultaneous trade keeps its normal lots', async () => {
  const { r } = await bothBreak({ sizingMode: 'FIXED', fixedLots: 4, multiSize: 'FULL' });
  assert.equal(lotsOf(r.state.position!, 65), 4);
  assert.equal(lotsOf(r.state.watch!.BANKNIFTY.position!, 30), 4);
});

test('one trade loses → the other keeps running, managed with its own prices; no new entries after the loss', async () => {
  const { r, at } = await bothBreak();
  const entry = r.state.position!.entry;
  assert.ok(Math.abs(entry - r.lastChain!.strikes.find((s) => s.strike === r.state.position!.strike)!.pe!.ltp) < 1e-9);
  await r.manualExit({ price: entry - 5 }); // NIFTY loses
  assert.ok(r.state.watch!.BANKNIFTY.position); // untouched
  at(4 * min);
  await r.refresh();
  assert.equal(r.config.symbol, 'BANKNIFTY'); // the Dashboard moves to the trade still open
  assert.equal(r.state.position?.symbol, 'BANKNIFTY');
  assert.equal(r.config.lotSize, 30); // its own contract preset
  assert.equal(r.state.watch!.NIFTY.position, null);
  assert.match(r.snapshot().watch!.find((x) => x.symbol === 'NIFTY')!.decision, /No-revenge-trade rule/);
  await r.manualExit({ price: r.state.position!.entry + 5 });
  assert.equal(r.state.journal.filter((j) => j.exit != null).length, 2);
});

test('a later signal on the other index enters while the first trade is open (split size)', async () => {
  const { r, view, ready, at } = setup({ sizingMode: 'FIXED', fixedLots: 4 });
  await ready;
  await r.refresh();
  view.NIFTY.brk = true; // only NIFTY breaks
  at(3 * min);
  await r.refresh();
  assert.equal(r.state.position?.symbol, 'NIFTY');
  assert.equal(lotsOf(r.state.position!, 65), 4); // alone: full size
  assert.equal(r.state.watch!.BANKNIFTY.position, null);
  view.BANKNIFTY.brk = true;
  at(4 * min);
  await r.refresh();
  const bank = r.state.watch!.BANKNIFTY.position!;
  assert.ok(bank, 'BANK NIFTY entered too');
  assert.equal(lotsOf(bank, 30), 2); // 2 trades open → half
  assert.equal(r.config.symbol, 'NIFTY'); // you stay on the trade you were watching
  assert.equal(r.state.tradesToday, 2);
});

test('LIVE automatic: both order requests go out in the same refresh, higher score first, each on its own index', async () => {
  const seen: { sym: string; lots: number }[] = [];
  const t = setup({ tradeMode: 'LIVE', autoEntryLive: true, sizingMode: 'FIXED', fixedLots: 4 });
  await t.ready;
  await t.r.updateConfig({ autoEntryLive: true }); // switching into LIVE turned it off
  t.r.afterCycle = async () => {
    // What LiveTrader does: take this index's request, place the order through ENTER's path.
    if (!t.r.takeAutoRequest()) return;
    const plan = t.r.entryPlan();
    seen.push({ sym: t.r.config.symbol, lots: plan.qty / t.r.config.lotSize });
    await t.r.manualEnter({ plan, live: { securityId: 'x', entryOrderId: '1', slOrderId: null }, auto: true });
  };
  await t.r.refresh();
  t.at(1 * min);
  await t.r.refresh();
  t.view.NIFTY.brk = t.view.BANKNIFTY.brk = true;
  t.at(3 * min);
  await t.r.refresh();
  assert.deepEqual(seen, [
    { sym: 'NIFTY', lots: 2 },
    { sym: 'BANKNIFTY', lots: 2 },
  ]);
  assert.equal(t.r.state.watch!.NIFTY.position?.symbol, 'NIFTY');
  assert.equal(t.r.state.watch!.BANKNIFTY.position?.symbol, 'BANKNIFTY');
  assert.equal(t.r.state.position?.symbol, 'NIFTY');
  assert.deepEqual(t.r.state.journal.map((j) => j.symbol), ['NIFTY', 'BANKNIFTY']);
});

test('daily limits are shared across indexes', async () => {
  const { r, view, ready, at } = setup({ maxTradesPerDay: 1 });
  await ready;
  await r.refresh();
  view.NIFTY.brk = view.BANKNIFTY.brk = true;
  at(3 * min);
  await r.refresh();
  await r.manualExit({ price: r.state.position!.entry + 5 });
  at(4 * min);
  await r.refresh();
  assert.equal(r.state.position, null);
  assert.match(r.snapshot().watch!.find((x) => x.symbol === 'BANKNIFTY')!.decision, /^BLOCKED - Daily trade limit reached \(1\/1\)/);
});

test('you can pick the index to look at / ENTER / EXIT on, also while trades are open', async () => {
  const { r, view, ready, at } = setup();
  await ready;
  await r.refresh();
  await r.setActive('BANKNIFTY');
  assert.equal(r.config.symbol, 'BANKNIFTY');
  assert.equal(r.dashboard!.decision.selectedStrike % 100, 0);
  at(1 * min);
  await r.refresh();
  assert.equal(r.config.symbol, 'BANKNIFTY'); // stays pinned
  view.NIFTY.brk = view.BANKNIFTY.brk = true;
  at(3 * min);
  await r.refresh(); // both enter; you were on BANK NIFTY → it stays on screen
  assert.equal(r.config.symbol, 'BANKNIFTY');
  assert.equal(r.state.position?.symbol, 'BANKNIFTY');
  await r.setActive('NIFTY');
  assert.equal(r.state.position?.symbol, 'NIFTY');
  await r.manualExit({ price: r.state.position!.entry + 3 }); // EXIT acts on the index shown
  assert.equal(r.state.watch!.NIFTY.position, null);
  assert.equal(r.state.watch!.BANKNIFTY.position?.symbol, 'BANKNIFTY');
  // multi-index can't be switched off while BANK NIFTY's trade is open
  await assert.rejects(r.updateConfig({ multiIndex: false }), /BANKNIFTY still has an open trade/);
});

test('turning multi-index off returns to one index and keeps each index’s IV history', async () => {
  const { r, ready } = setup();
  await ready;
  await r.refresh();
  const bnIv = r.state.watch!.BANKNIFTY.ivHistory.length;
  await r.updateConfig({ multiIndex: false });
  assert.equal(r.state.watch, undefined);
  assert.equal(r.state.ivBank!.BANKNIFTY.length, bnIv);
  assert.equal(r.snapshot().watch, undefined);
  await r.refresh(); // single-index refresh works again
  assert.equal(r.status, 'Ready');
});

test('phone: multi-index loads NIFTY and BANK NIFTY chains from Dhan each refresh', async () => {
  const { createLocalApi } = await import('../src/api/localApi.ts');
  const { FAKE_CLIENT, FAKE_TOKEN, GOLDEN_EXPIRY, startFakeDhan } = await import('./fakeDhan.ts');
  const fake = await startFakeDhan();
  const api = await createLocalApi({
    positionTickMs: 0,
    clientId: FAKE_CLIENT,
    accessToken: FAKE_TOKEN,
    baseUrl: fake.url,
    store: { load: async () => null, save: async () => {} },
    staticIp: () => '',
    publicIp: async () => '198.51.100.20',
    sleep: async () => {},
  });
  try {
    await api.engineConfig({ expiry: GOLDEN_EXPIRY, lastEntryTime: '', multiIndex: true, watchSymbols: ['NIFTY', 'BANKNIFTY'] });
    const n = fake.requests.length;
    const s = await api.engineRefresh();
    const chains = fake.requests.slice(n).filter((q) => q.path === '/optionchain').map((q) => q.body.UnderlyingScrip);
    assert.deepEqual(chains, [13, 25]);
    assert.deepEqual(s.watch!.map((w) => w.symbol), ['NIFTY', 'BANKNIFTY']);
    const active = s.watch!.find((w) => w.active)!.symbol;
    const other = active === 'NIFTY' ? 'BANKNIFTY' : 'NIFTY';
    const s2 = await api.engineSetActive(other);
    assert.equal(s2.config.symbol, other);
  } finally {
    api.dispose();
    fake.server.close();
  }
});
