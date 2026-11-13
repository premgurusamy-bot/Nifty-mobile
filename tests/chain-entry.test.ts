/// <reference types="node" />
/** Option Chain BUY → engine trade: the engine's stop / targets / lock for the picked strike, your quantity. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { LiveTrader } from '../server/liveTrader.ts';
import { EngineRunner } from '../src/lib/engine/runner.ts';
import { DEFAULT_CONFIG, initialEngineState, type Candle, type ChainSnapshot, type JournalRow } from '../src/lib/engine/types.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/workbook-2026-08-27.json', import.meta.url), 'utf8'));
const candles: Candle[] = fx.candles;
const chain: ChainSnapshot = { ...fx.chain, expiry: fx.chain.expiry || '2026-08-28' }; // LIVE entries need the expiry
const now = candles.at(-1)!.t + 60_000;

async function runner(over: Record<string, unknown> = {}) {
  const r = new EngineRunner(
    { load: async () => ({ candles, chain }), now: () => now, alwaysOpen: true },
    { load: async () => ({ state: { ...initialEngineState(), ivHistory: fx.ivHistoryBefore }, config: { ...DEFAULT_CONFIG, lastEntryTime: '', maxTradesPerDay: 10, maxLots: 10, autoEntry: false, ...over } }), save: async () => {} },
  );
  await r.init();
  await r.refresh();
  return r;
}
// A strike in the fixture's chain, a little away from the engine's own pick.
const atm = () => chain.strikes.reduce((b, s) => (Math.abs(s.strike - chain.spot) < Math.abs(b.strike - chain.spot) ? s : b)).strike;

test('paper: the picked strike opens an engine trade with the engine stop / targets and your lots', async () => {
  const r = await runner();
  const strike = atm() + 50;
  await r.placeEntry(undefined, { direction: 'CE', strike, qty: 6 * 65 });
  const p = r.state.position!;
  assert.ok(p, r.status);
  assert.deepEqual([p.direction, p.strike, p.totalQty], ['CE', strike, 390]);
  const ce = chain.strikes.find((s) => s.strike === strike)!.ce!.ltp;
  assert.ok(Math.abs(p.entry - ce) < 1e-9, 'filled at the strike\'s premium');
  assert.ok(p.currentSl < p.entry && p.target1 > p.entry, 'engine stop below, Target 1 above');
  assert.equal(r.state.journal.at(-1)!.strike, strike);
  assert.equal(p.dayPlan, 'FIRST', 'the day plan applies (trade 1)');
});

test('your quantity: whole lots, capped at Max lots; less than a lot is refused', async () => {
  const r = await runner();
  const plan = r.entryPlan({ direction: 'PE', strike: atm(), qty: 1040 }); // 16 lots asked
  assert.equal(plan.qty, 650);
  assert.match(plan.sizing!, /capped at max lots 10/);
  assert.throws(() => r.entryPlan({ direction: 'PE', strike: atm(), qty: 40 }), /at least 1 lot/);
  assert.equal(r.entryPlan({ direction: 'PE', strike: atm(), qty: 200 }).qty, 195); // 3 lots
});

test('the daily rules still apply, and a strike outside the engine chain is refused', async () => {
  const r = await runner();
  assert.throws(() => r.entryPlan({ direction: 'CE', strike: 99_950, qty: 65 }), /isn't in the engine's option chain/);
  const loss: JournalRow = { id: 'J1', date: r.state.day, time: '09:20:00', spot: 0, strike: 1, direction: 'CE', entry: 100, sl: 90, target: 120, exit: 90, pnl: -650, confidence: 85, trend: '', pcr: 1, oiBias: '', iv: 12, delta: 0.5, entryReason: '', exitReason: '' };
  r.state = { ...r.state, journal: [loss] };
  assert.throws(() => r.entryPlan({ direction: 'CE', strike: atm(), qty: 65 }), /No-revenge/);
  await r.clearLossBlock();
  assert.equal(r.entryPlan({ direction: 'CE', strike: atm(), qty: 65 }).qty, 65);
});

test('LIVE: the picked strike is bought at market and gets the exchange stop-loss', async () => {
  const r = await runner({ tradeMode: 'LIVE' });
  const placed: any[] = [];
  const orders = new Map<string, any>();
  const gw = {
    name: 'DHAN' as const,
    ready: () => true,
    instrument: async (_c: unknown, plan: { strike: number; direction: string }) => ({ securityId: `${plan.strike}${plan.direction}` }),
    place: async (a: any) => {
      const id = `O${placed.length + 1}`;
      placed.push(a);
      orders.set(id, { orderStatus: a.type === 'MARKET' ? 'TRADED' : 'PENDING', filledQty: a.type === 'MARKET' ? a.qty : 0, quantity: a.qty, averageTradedPrice: 120 });
      return id;
    },
    order: async (id: string) => orders.get(id),
    cancel: async () => {},
    findRecent: async () => null,
    positions: async () => [],
  };
  // v2 trades through the gateway; the licensed v1 talks to Dhan (and its order service) directly.
  const dhan = {
    placeOrder: async (o: any) => ({ orderId: await gw.place({ type: o.orderType, side: o.transactionType, qty: o.quantity, inst: { securityId: o.securityId } }) }),
    order: async (id: string) => gw.order(id),
    cancelOrder: async () => ({}),
    positions: async () => [],
    orders: async () => [],
  };
  const service = {
    toDhan: (id: string) => {
      const [, , , k, typ] = id.split(':');
      return { segment: 'NSE_FNO', securityId: `${k}${typ}` };
    },
    optionChain: async () => ({}),
  };
  const t = new LiveTrader(dhan as never, service as never, { dhanGateway: gw as never, sleep: async () => {} });
  const strike = atm() - 50;
  await t.enter(r, undefined, { pick: { direction: 'PE', strike, qty: 4 * 65 } });
  assert.deepEqual(placed.map((a) => [a.type, a.side, a.qty, a.inst.securityId]), [
    ['MARKET', 'BUY', 260, `${strike}PE`],
    ['STOP_LOSS', 'SELL', 260, `${strike}PE`],
  ]);
  const p = r.state.position!;
  assert.deepEqual([p.direction, p.strike, p.totalQty, p.entry], ['PE', strike, 260, 120]);
  assert.ok(p.live?.slOrderId);
});
