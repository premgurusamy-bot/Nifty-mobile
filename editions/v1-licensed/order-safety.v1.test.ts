/// <reference types="node" />
/**
 * Licensed v1 — audit fixes J-1 / J-2 / J-4 against a MOCK Dhan client (no network, no real
 * endpoints), and J-3 (settings). Same scenarios and invariants as v2's tests/order-safety.test.ts:
 * never more sold than held, never more in working stops than held, never two working stops.
 * (Copied into a v1 checkout by editions/v1-licensed/test-patches.mjs.)
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveTrader } from '../server/liveTrader.ts';
import { EngineRunner, migrateConfig, CONFIG_REV } from '../src/lib/engine/runner.ts';
import { DEFAULT_CONFIG, initialEngineState, type EngineConfig, type EngineState, type OpenPosition } from '../src/lib/engine/types.ts';

type Ord = { orderId: string; orderType: string; transactionType: 'BUY' | 'SELL'; quantity: number; filledQty: number; orderStatus: string; averageTradedPrice: number; triggerPrice?: number };

function mockDhan() {
  const orders = new Map<string, Ord>();
  let n = 0;
  const log: string[] = [];
  const m = {
    orders,
    log,
    cancelMode: 'ok' as 'ok' | 'timeout' | 'reject',
    positionsDown: false,
    onCancel: null as ((o: Ord) => void) | null,
    outside: 0,
    held: () => [...orders.values()].reduce((q, o) => q + (o.transactionType === 'BUY' ? 1 : -1) * o.filledQty, 0) + m.outside,
    working: () => [...orders.values()].filter((o) => o.orderType === 'STOP_LOSS' && /PENDING|PART_TRADED/.test(o.orderStatus)),
    workingStopQty: () => m.working().reduce((q, o) => q + (o.quantity - o.filledQty), 0),
    fill(id: string, qty?: number) {
      const o = orders.get(id)!;
      o.filledQty = qty ?? o.quantity;
      o.orderStatus = o.filledQty >= o.quantity ? 'TRADED' : 'PART_TRADED';
      o.averageTradedPrice = o.triggerPrice ?? 100;
      log.push(`exchange fills ${id} ${o.filledQty}`);
    },
    client: {
      placeOrder: async (p: any) => {
        const id = `O${++n}`;
        const market = p.orderType === 'MARKET';
        orders.set(id, { orderId: id, orderType: p.orderType, transactionType: p.transactionType, quantity: p.quantity, filledQty: market ? p.quantity : 0, orderStatus: market ? 'TRADED' : 'PENDING', averageTradedPrice: market ? 101 : 0, triggerPrice: p.triggerPrice });
        log.push(`place ${id} ${p.orderType} ${p.transactionType} ${p.quantity}${p.triggerPrice != null ? ` @${p.triggerPrice}` : ''}`);
        return { orderId: id, orderStatus: market ? 'TRADED' : 'PENDING' };
      },
      order: async (id: string) => {
        const o = orders.get(id);
        return o ? { ...o } : null;
      },
      cancelOrder: async (id: string) => {
        const o = orders.get(id)!;
        m.onCancel?.(o);
        if (m.cancelMode === 'timeout') {
          log.push(`cancel ${id} → no reply`);
          throw new Error('Cannot reach Dhan: timeout');
        }
        if (m.cancelMode === 'reject') {
          log.push(`cancel ${id} → refused`);
          throw new Error('DH-906 cancel refused');
        }
        if (o.orderStatus === 'TRADED') {
          log.push(`cancel ${id} → already traded`);
          throw new Error('DH-906 Order is TRADED');
        }
        o.orderStatus = 'CANCELLED';
        log.push(`cancel ${id}`);
      },
      orders: async () => [...orders.values()],
      positions: async () => {
        if (m.positionsDown) throw new Error('Cannot reach Dhan: positions');
        return [{ securityId: '777', netQty: m.held(), productType: 'INTRADAY' }];
      },
    },
  };
  return m;
}

const cfg: EngineConfig = { ...DEFAULT_CONFIG, tradeMode: 'LIVE', lotSize: 65, liveProduct: 'INTRADAY' };

async function setup() {
  const b = mockDhan();
  const trader = new LiveTrader(b.client as never, null as never, { sleep: async () => {} });
  Object.assign(trader, { reconEveryMs: 0, flatConfirmMs: 0, freshEntryMs: 0, retryMs: 0 });
  const runner = new EngineRunner({ load: async () => { throw new Error('unused'); } } as never, { load: async () => null, save: async () => {} });
  runner.config = cfg;
  runner.marketOpen = () => true;
  const entry = (await b.client.placeOrder({ orderType: 'MARKET', transactionType: 'BUY', quantity: 650 })).orderId;
  const sl = (await b.client.placeOrder({ orderType: 'STOP_LOSS', transactionType: 'SELL', quantity: 650, triggerPrice: 189.1 })).orderId;
  const pos = {
    direction: 'CE', strike: 24300, entry: 200, originalSl: 189.1, target1: 221.85, target2: 232.8, totalQty: 650, journalId: 'J1', openedAt: 0,
    partialBooked: false, partialQty: 0, partialPnl: 0, remainingQty: 650, currentSl: 189.1, side: 1, pointValue: 1, symbol: 'NIFTY',
    live: { securityId: '777', entryOrderId: entry, slOrderId: sl, slTrigger: 189.1, slQty: 650 },
  } as OpenPosition;
  const journal = [{ id: 'J1', date: '2026-11-11', time: '10:00:00', spot: 0, strike: 24300, direction: 'CE', entry: 200, sl: 189.1, target: 221.85, exit: null, pnl: null, confidence: 85, trend: '', pcr: 1, oiBias: '', iv: 12, delta: 0.5, entryReason: '', exitReason: '' }];
  runner.state = { ...initialEngineState(), day: '2026-11-11', journal, position: pos } as unknown as EngineState;
  b.log.length = 0;
  return { b, trader, runner, sl, pos };
}
const st = (runner: EngineRunner, position: OpenPosition | null) => ({ ...runner.state, position }) as EngineState;
async function engineExit(runner: EngineRunner, trader: LiveTrader, prev: OpenPosition) {
  const closed = { ...runner.state, position: null, journal: runner.state.journal.map((j) => ({ ...j, exit: prev.currentSl, pnl: (prev.currentSl - 200) * 650 })) } as EngineState;
  runner.state = closed;
  await trader.afterCycle(runner, st(runner, prev), closed);
}
function invariants(b: ReturnType<typeof mockDhan>, label: string) {
  assert.ok(b.held() >= 0, `${label}: oversold — net ${b.held()}\n${b.log.join('\n')}`);
  assert.ok(b.workingStopQty() <= Math.max(0, b.held()), `${label}: working stops ${b.workingStopQty()} > held ${b.held()}\n${b.log.join('\n')}`);
  assert.ok(b.working().length <= 1, `${label}: ${b.working().length} working stops\n${b.log.join('\n')}`);
}
const sells = (b: ReturnType<typeof mockDhan>) => [...b.orders.values()].filter((o) => o.orderType === 'MARKET' && o.transactionType === 'SELL');

test('v1 J-1 · stop filled just before / at the same moment as the app exit → no SELL', async () => {
  for (const when of ['before', 'during'] as const) {
    const { b, trader, runner, sl, pos } = await setup();
    if (when === 'before') b.fill(sl);
    else b.onCancel = (o) => o.orderId === sl && o.orderStatus === 'PENDING' && b.fill(sl);
    await engineExit(runner, trader, pos);
    assert.equal(sells(b).length, 0, `${when}\n${b.log.join('\n')}`);
    assert.equal(b.held(), 0);
    invariants(b, when);
  }
});

test('v1 J-1 · manual EXIT racing the exchange stop, and a partial stop fill → never more sold than held', async () => {
  const a = await setup();
  a.b.onCancel = (o) => o.orderId === a.sl && o.orderStatus === 'PENDING' && a.b.fill(a.sl);
  await a.trader.exit(a.runner);
  assert.equal(a.b.held(), 0, a.b.log.join('\n'));
  invariants(a.b, 'manual exit race');
  const p = await setup();
  p.b.fill(p.sl, 325);
  await engineExit(p.runner, p.trader, p.pos);
  assert.deepEqual(sells(p.b).map((o) => o.quantity), [325], p.b.log.join('\n'));
  invariants(p.b, 'partial stop');
});

test('v1 J-2 · cancel times out / is refused → no SELL, no second stop; a raise is retried later', async () => {
  const x = await setup();
  x.b.cancelMode = 'timeout';
  await engineExit(x.runner, x.trader, x.pos);
  assert.equal(sells(x.b).length, 0, x.b.log.join('\n'));
  assert.equal(x.b.working().length, 1);
  assert.match(x.runner.status, /could not be confirmed cancelled/);
  invariants(x.b, 'exit timeout');

  const r = await setup();
  r.b.cancelMode = 'reject';
  const raised = { ...r.pos, currentSl: 207.7 };
  r.runner.state = st(r.runner, raised);
  await r.trader.afterCycle(r.runner, st(r.runner, r.pos), st(r.runner, raised));
  assert.deepEqual(r.b.working().map((o) => o.triggerPrice), [189.1], r.b.log.join('\n'));
  invariants(r.b, 'raise refused');
  r.b.cancelMode = 'ok';
  await r.trader.afterCycle(r.runner, st(r.runner, r.runner.state.position), st(r.runner, r.runner.state.position));
  assert.deepEqual(r.b.working().map((o) => [o.triggerPrice, o.quantity]), [[207.7, 650]], r.b.log.join('\n'));
  invariants(r.b, 'raise retried');

  const t = await setup();
  t.b.cancelMode = 'timeout';
  const t1 = { ...t.pos, partialBooked: true, partialQty: 325, partialPnl: 7100, remainingQty: 325, currentSl: 200 };
  t.runner.state = st(t.runner, t1);
  await t.trader.afterCycle(t.runner, st(t.runner, t.pos), st(t.runner, t1));
  assert.equal(sells(t.b).length, 0, t.b.log.join('\n'));
  invariants(t.b, 'T1 with timeout');
});

test('v1 J-4 · manual exit / auto square-off / partial outside exit / restart / network down', async () => {
  const m = await setup();
  m.b.outside = -650;
  for (let i = 0; i < 2; i++) await m.trader.afterCycle(m.runner, st(m.runner, m.runner.state.position), st(m.runner, m.runner.state.position));
  assert.equal(m.runner.state.position, null, m.b.log.join('\n'));
  assert.match(m.runner.state.journal[0].exitReason, /CLOSED OUTSIDE THE APP/);
  assert.equal(m.b.working().length, 0);
  assert.equal(sells(m.b).length, 0);

  const sq = await setup();
  sq.b.outside = -650;
  sq.b.orders.get(sq.sl)!.orderStatus = 'CANCELLED';
  Object.assign(sq.trader, { reconEveryMs: 60_000 });
  for (let i = 0; i < 2; i++) await sq.trader.afterCycle(sq.runner, st(sq.runner, sq.runner.state.position), st(sq.runner, sq.runner.state.position));
  assert.equal(sq.b.working().length, 0, sq.b.log.join('\n'));
  assert.equal(sq.runner.state.position, null);

  const pe = await setup();
  pe.b.outside = -325;
  await pe.trader.afterCycle(pe.runner, st(pe.runner, pe.runner.state.position), st(pe.runner, pe.runner.state.position));
  assert.deepEqual(pe.b.working().map((o) => o.quantity), [325], pe.b.log.join('\n'));
  invariants(pe.b, 'partial outside exit');

  const rs = await setup();
  const fresh = new LiveTrader(rs.b.client as never, null as never, { sleep: async () => {} });
  await fresh.afterCycle(rs.runner, st(rs.runner, rs.runner.state.position), st(rs.runner, rs.runner.state.position));
  assert.equal(rs.b.log.filter((l) => /^place|^cancel/.test(l)).length, 0, rs.b.log.join('\n'));

  const nd = await setup();
  nd.b.positionsDown = true;
  nd.b.outside = -650;
  for (let i = 0; i < 3; i++) await nd.trader.afterCycle(nd.runner, st(nd.runner, nd.runner.state.position), st(nd.runner, nd.runner.state.position));
  assert.ok(nd.runner.state.position, 'not assumed closed');
  nd.b.orders.get(nd.sl)!.orderStatus = 'CANCELLED';
  await nd.trader.afterCycle(nd.runner, st(nd.runner, nd.runner.state.position), st(nd.runner, nd.runner.state.position));
  assert.equal(nd.b.working().length, 0);
  assert.match(nd.runner.status, /protection can't be confirmed/);
});

test('v1 J-3 · fresh install → settings → restarts: settings survive; migration is idempotent', async () => {
  let saved: any = null;
  const store = { load: async () => saved, save: async (state: any, config: any) => void (saved = JSON.parse(JSON.stringify({ state, config }))) };
  const src = { load: async () => { throw new Error('offline'); } } as never;
  const a = new EngineRunner(src, store);
  await a.init();
  const mine = { confirmHoldMinutes: 5, maxRisk: 20000, maxLots: 10 } as Partial<EngineConfig>;
  await a.updateConfig(mine);
  for (let i = 0; i < 3; i++) {
    const r = new EngineRunner(src, store);
    await r.init();
    assert.deepEqual([r.config.confirmHoldMinutes, r.config.maxRisk, r.config.maxLots], [5, 20000, 10], `restart ${i + 1}`);
    await r.updateConfig({});
  }
  const once = migrateConfig({ ...DEFAULT_CONFIG, confirmHoldMinutes: 5 }, { configRev: 0, confirmHoldMinutes: 5 });
  assert.equal(once.configRev, CONFIG_REV);
  assert.deepEqual(migrateConfig(once, once), once);
});
