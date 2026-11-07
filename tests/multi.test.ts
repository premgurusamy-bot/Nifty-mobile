/// <reference types="node" />
/**
 * Multi-index engine: NIFTY + BANK NIFTY watched together — own setups / holds / IV, one shared
 * account, one trade at a time, highest score wins, shared limits, the active index follows the trade.
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
    await r.updateConfig({ multiIndex: true, lastEntryTime: '', dayPlanLock: false, ...over });
  })();
  return { r, view, loads, ready, at: (ms: number) => (now = t0 + ms) };
}

test('settings: off by default; index options only', () => {
  assert.deepEqual([DEFAULT_CONFIG.multiIndex, DEFAULT_CONFIG.watchSymbols], [false, ['NIFTY', 'BANKNIFTY']]);
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

test('both qualify in the same cycle → only the higher score enters; the other watches', async () => {
  const { r, view, ready, at } = setup();
  await ready;
  await r.refresh(); // arm both
  at(1 * min);
  await r.refresh();
  view.NIFTY.brk = view.BANKNIFTY.brk = true;
  at(3 * min); // both held 3 min, both break
  await r.refresh();
  const pos = r.state.position!;
  assert.ok(pos);
  assert.equal(pos.symbol, 'NIFTY');
  assert.equal(r.state.tradesToday, 1);
  assert.equal(r.state.journal.length, 1);
  const w = r.snapshot().watch!;
  assert.match(w.find((x) => x.symbol === 'BANKNIFTY')!.decision, /NIFTY taken instead \(higher score/);
  assert.equal(r.config.symbol, 'NIFTY');
  // next refresh: BANK NIFTY is watch-only while the NIFTY trade is open
  at(4 * min);
  await r.refresh();
  const bn = r.snapshot().watch!.find((x) => x.symbol === 'BANKNIFTY')!;
  assert.equal(bn.decision, 'BLOCKED - In a NIFTY trade — watching only');
  assert.equal(r.state.journal.length, 1);
  assert.equal(r.snapshot().watch!.find((x) => x.symbol === 'NIFTY')!.inTrade, true);
});

test('the trade is managed with its own index’s prices; after a winning exit the other index can enter', async () => {
  const { r, view, ready, at } = setup();
  await ready;
  await r.refresh();
  view.NIFTY.brk = view.BANKNIFTY.brk = true;
  at(3 * min);
  await r.refresh();
  const entry = r.state.position!.entry;
  assert.ok(Math.abs(entry - (r.lastChain!.strikes.find((s) => s.strike === r.state.position!.strike)!.pe!.ltp)) < 1e-9);
  await r.manualExit({ price: entry + 5 }); // a win, so no-revenge doesn't block
  at(4 * min);
  await r.refresh(); // BANK NIFTY's setup is still armed and held → it enters now
  assert.equal(r.state.position?.symbol, 'BANKNIFTY');
  assert.equal(r.state.tradesToday, 2);
  assert.equal(r.config.symbol, 'BANKNIFTY');
  assert.equal(r.config.lotSize, 30); // its own contract preset
  assert.deepEqual(r.state.journal.map((j) => j.symbol), ['NIFTY', 'BANKNIFTY']);
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

test('you can pick the index to look at / ENTER on — but not while a trade is open', async () => {
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
  await r.refresh(); // NIFTY wins on score → becomes active, pin released
  assert.equal(r.config.symbol, 'NIFTY');
  await assert.rejects(r.setActive('BANKNIFTY'), /A trade is open/);
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
    await api.engineConfig({ expiry: GOLDEN_EXPIRY, lastEntryTime: '', multiIndex: true });
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
