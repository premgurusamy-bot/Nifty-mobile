/// <reference types="node" />
/** Angel One data for BANK NIFTY (PAPER): login, candles + chain from quotes/Greeks, ticks, fallback to Dhan. */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { AngelClient, angelLogin } from '../server/angel.ts';
import { AngelEngineSource, angelExpiry, parseOptionSymbol } from '../server/angelSource.ts';
import { RoutedEngineSource } from '../server/routedSource.ts';
import { sanitizeConfig } from '../src/lib/engine/runner.ts';
import { tickRequests } from '../src/lib/engine/ticks.ts';
import { totpNow } from '../src/lib/totp.ts';
import { DEFAULT_CONFIG } from '../src/lib/engine/types.ts';
import { ANGEL_CLIENT, ANGEL_EXPIRY, ANGEL_KEY, ANGEL_PIN, ANGEL_TOTP_KEY, startFakeAngel } from './fakeAngel.ts';

let fa: Awaited<ReturnType<typeof startFakeAngel>>;
before(async () => {
  fa = await startFakeAngel();
});
after(() => fa.server.close());
const now = Date.UTC(2099, 11, 29, 6, 0); // 11:30 IST
const bank = sanitizeConfig({ symbol: 'BANKNIFTY' }, DEFAULT_CONFIG);
const login = () => angelLogin({ apiKey: ANGEL_KEY, clientCode: ANGEL_CLIENT.toLowerCase(), pin: ANGEL_PIN, totp: totpNow(ANGEL_TOTP_KEY), baseUrl: fa.url });

test('symbols and expiry formats', () => {
  assert.deepEqual(parseOptionSymbol('BANKNIFTY', 'BANKNIFTY25NOV2654000CE'), { expiry: '2026-11-25', strike: 54000, type: 'CE' });
  assert.equal(parseOptionSymbol('NIFTY', 'BANKNIFTY25NOV2654000CE'), null);
  assert.equal(parseOptionSymbol('BANKNIFTY', 'BANKNIFTY25NOV26FUT'), null);
  assert.equal(angelExpiry('2026-11-25'), '25NOV2026');
  assert.equal(angelExpiry('2026-11-25', false), '25NOV26');
});

test('login: client code + MPIN + TOTP → session (wrong PIN / TOTP refused with Angel’s message)', async () => {
  const s = await login();
  assert.deepEqual([s.clientCode, s.jwtToken, s.apiKey], [ANGEL_CLIENT, 'fake-angel-jwt', ANGEL_KEY]); // "Bearer " stripped
  const q = fa.requests.at(-1)!;
  assert.equal(q.headers['x-privatekey'], ANGEL_KEY);
  assert.equal(q.headers['x-usertype'], 'USER');
  await assert.rejects(angelLogin({ apiKey: ANGEL_KEY, clientCode: ANGEL_CLIENT, pin: '9999', totp: totpNow(ANGEL_TOTP_KEY), baseUrl: fa.url }), /Invalid clientcode or password \(AB1007\)/);
  await assert.rejects(angelLogin({ apiKey: ANGEL_KEY, clientCode: ANGEL_CLIENT, pin: ANGEL_PIN, totp: '000000', baseUrl: fa.url }), /Invalid totp/);
  await assert.rejects(angelLogin({ apiKey: ANGEL_KEY, clientCode: ANGEL_CLIENT, pin: '12', totp: '1', baseUrl: fa.url }), /MPIN/);
});

test('BANK NIFTY from Angel: candles, ATM ± 20 strikes with LTP / OI / IV / Greeks and Angel tokens', async () => {
  const angel = new AngelClient({ baseUrl: fa.url, session: await login() });
  const n = fa.requests.length;
  const d = await new AngelEngineSource(angel).load(bank, now);
  assert.equal(d.chain.expiry, ANGEL_EXPIRY);
  assert.equal(d.chain.spot, fa.state.spot);
  assert.equal(d.chain.feed, 'ANGEL');
  assert.equal(d.candles.length, 60);
  assert.equal(d.chain.strikes.length, 41);
  const atm = d.chain.strikes.find((s) => s.strike === 54200)!;
  assert.ok(atm.ce!.ltp > 0 && atm.ce!.oi > 0);
  assert.equal(atm.pe!.iv, 14.25);
  assert.equal(atm.ce!.delta, 0.5);
  assert.equal(atm.ce!.securityId, '600032');
  const quotes = fa.requests.slice(n).filter((r) => r.path.endsWith('/quote/'));
  assert.equal(quotes.length, 2); // 1 index + 82 options, 50 per call
  assert.deepEqual(quotes[0].body.exchangeTokens.NSE, ['99926009']);
  // Ticks quote BANK NIFTY through Angel: index + option tokens on the ANGEL segments.
  const reqs = tickRequests(bank, d, { position: null, pending: null, pendingEntry: null });
  assert.deepEqual(reqs[0], { segment: 'ANGEL:NSE', securityId: '99926009' });
  assert.ok(reqs.slice(1).every((r) => r.segment === 'ANGEL:NFO'));
});

test('routing: Angel for the indexes set to it; not logged in or session ended → Dhan, with the reason', async () => {
  const dhanLoads: string[] = [];
  const dhan = { load: async (c: typeof bank) => (dhanLoads.push(c.symbol), { candles: [{ t: 0, o: 1, h: 1, l: 1, c: 1, v: 0 }], chain: { spot: 1, expiry: 'x', strikes: [] } }) };
  const angel = new AngelClient({ baseUrl: fa.url });
  const r = new RoutedEngineSource(dhan, angel);
  let lost = 0;
  r.onAngelSessionLost = () => lost++;
  const cfg = { ...bank, angelSymbols: ['BANKNIFTY'] };
  assert.equal((await r.load({ ...DEFAULT_CONFIG, angelSymbols: ['BANKNIFTY'] }, now)).chain.feed, undefined); // NIFTY: Dhan
  let d = await r.load(cfg, now);
  assert.deepEqual([d.chain.feed, d.chain.feedNote], ['DHAN', 'Angel One not logged in — using Dhan']);
  angel.session = await login();
  d = await r.load(cfg, now);
  assert.equal(d.chain.feed, 'ANGEL');
  fa.state.failWith = 'AG8001';
  try {
    d = await r.load(cfg, now);
  } finally {
    fa.state.failWith = '';
  }
  assert.match(d.chain.feedNote!, /session ended — log in again/);
  assert.equal(angel.connected, false);
  assert.equal(lost, 1);
  // An API key Angel refuses on data calls (AG8004): stays logged in (so Test can diagnose), Dhan meanwhile.
  angel.session = await login();
  fa.state.failWith = 'AG8004';
  try {
    d = await r.load(cfg, now);
  } finally {
    fa.state.failWith = '';
  }
  assert.match(d.chain.feedNote!, /refused the API key — Settings → Angel One → Test shows which call; using Dhan/);
  assert.equal(angel.connected, true);
  assert.equal(lost, 1);
  assert.deepEqual(dhanLoads, ['NIFTY', 'BANKNIFTY', 'BANKNIFTY', 'BANKNIFTY']);
});

test('settings: which indexes use Angel One', () => {
  assert.deepEqual(DEFAULT_CONFIG.angelSymbols, ['FINNIFTY']);
  assert.deepEqual(sanitizeConfig({ angelSymbols: ['banknifty'] }, DEFAULT_CONFIG).angelSymbols, ['BANKNIFTY']);
  assert.throws(() => sanitizeConfig({ angelSymbols: ['GOLDM'] }, DEFAULT_CONFIG), /can't use Angel One data/);
});

test('phone: multi-index with BANK NIFTY on Angel — NIFTY from Dhan, BANK NIFTY from Angel', async () => {
  const { createLocalApi } = await import('../src/api/localApi.ts');
  const { FAKE_CLIENT, FAKE_TOKEN, GOLDEN_EXPIRY, startFakeDhan } = await import('./fakeDhan.ts');
  const fake = await startFakeDhan();
  const api = await createLocalApi({
    positionTickMs: 0,
    clientId: FAKE_CLIENT,
    accessToken: FAKE_TOKEN,
    baseUrl: fake.url,
    angelBaseUrl: fa.url,
    store: { load: async () => null, save: async () => {} },
    staticIp: () => '',
    publicIp: async () => '198.51.100.20',
    sleep: async () => {},
  });
  try {
    assert.equal(api.angelStatus().connected, false);
    assert.equal(api.angelSetSession(await login()).connected, true);
    const t = await api.angelTest();
    assert.deepEqual([t.symbol, t.expiry, t.strikes, t.withIv], ['BANKNIFTY', ANGEL_EXPIRY, 41, 41]);
    await api.engineConfig({ expiry: GOLDEN_EXPIRY, lastEntryTime: '', multiIndex: true, watchSymbols: ['NIFTY', 'BANKNIFTY'], angelSymbols: ['BANKNIFTY'] });
    const nd = fake.requests.length;
    const s = await api.engineRefresh();
    const chains = fake.requests.slice(nd).filter((q) => q.path === '/optionchain').map((q) => q.body.UnderlyingScrip);
    assert.deepEqual(chains, [13]); // only NIFTY's chain from Dhan
    assert.deepEqual(s.feeds, { NIFTY: { feed: 'DHAN' }, BANKNIFTY: { feed: 'ANGEL' } });
    const engine = api.runner;
    await engine.setActive('BANKNIFTY');
    assert.equal(engine.lastChain?.feed, 'ANGEL');
    // A tick: Dhan quotes NIFTY, Angel quotes BANK NIFTY (LTP mode).
    const na = fa.requests.length;
    await engine.tick();
    const ltp = fa.requests.slice(na).filter((r) => r.path.endsWith('/quote/'));
    assert.equal(ltp.length, 1);
    assert.equal(ltp[0].body.mode, 'LTP');
    assert.deepEqual(ltp[0].body.exchangeTokens.NSE, ['99926009']);

  } finally {
    api.dispose();
    fake.server.close();
  }
});

test('diagnose: each call on its own, IP variants, and a note when the phone is off the static IP', async () => {
  const angel = new AngelClient({ baseUrl: fa.url, session: await login(), publicIp: () => '203.0.113.7' });
  const lines = await angel.diagnose({ staticIp: '203.0.113.7', phoneIp: '198.51.100.20' });
  assert.match(lines[0], /^Client A123456 · API key …-key/);
  assert.ok(lines.includes('✓ profile (sending static IP 203.0.113.7)'));
  assert.ok(lines.includes("✓ profile (sending phone's current IP 198.51.100.20)"));
  assert.ok(lines.includes('✓ contract search (BANKNIFTY options)'));
  assert.match(lines.at(-1)!, /phone is on 198.51.100.20, not the static IP/);
  fa.state.failWith = 'AG8004';
  try {
    const bad = await angel.diagnose({ staticIp: '203.0.113.7', phoneIp: '203.0.113.7' });
    assert.ok(bad.some((l) => l === '✗ contract search (BANKNIFTY options): Invalid API Key (AG8004)'), bad.join('\n'));
  } finally {
    fa.state.failWith = '';
  }
  assert.equal(angel.publicIp(), '203.0.113.7'); // restored
});

test('candles: fetched once per new 5-min candle / minute, the forming candle follows the live price; rate limits ridden out', async () => {
  const angel = new AngelClient({ baseUrl: fa.url, session: await login() });
  const src = new AngelEngineSource(angel);
  const t = Date.UTC(2099, 11, 29, 6, 0, 10); // 11:30:10 IST
  const n = fa.state.candleCalls;
  const a = await src.load(bank, t);
  await src.load(bank, t + 5_000);
  await src.load(bank, t + 20_000);
  assert.equal(fa.state.candleCalls - n, 1); // one fetch for three refreshes
  fa.state.spot += 40;
  const b = await src.load(bank, t + 30_000);
  assert.equal(b.candles.at(-1)!.c, fa.state.spot); // forming candle = live index price
  assert.ok(b.candles.at(-1)!.h >= fa.state.spot);
  assert.equal(a.candles.length <= b.candles.length, true);
  // A new 5-min candle (11:35:05): fetched again.
  await src.load(bank, Date.UTC(2099, 11, 29, 6, 5, 6));
  assert.equal(fa.state.candleCalls - n, 2);
  // Rate-limited: keeps the candles it has (no error, stays on Angel), tries again after the pause.
  fa.state.rateLimitCandles = true;
  try {
    const c = await src.load(bank, Date.UTC(2099, 11, 29, 6, 6, 10));
    assert.equal(c.chain.feed, 'ANGEL');
    assert.ok(c.candles.length > 0);
    const calls = fa.state.candleCalls;
    await src.load(bank, Date.UTC(2099, 11, 29, 6, 6, 20)); // within the 30 s pause: no request
    assert.equal(fa.state.candleCalls, calls);
  } finally {
    fa.state.rateLimitCandles = false;
    fa.state.spot -= 40;
  }
});
