/// <reference types="node" />
/**
 * Audit fixes J-1 / J-2 / J-4 (order safety) and J-3 (settings), against an in-memory MOCK broker:
 * no network, no real broker endpoints. Invariants checked throughout: never more sold than held,
 * never more in working stop orders than held, never two working stops.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveTrader } from '../server/liveTrader.ts';
import { cancelConfirmed, heldQty } from '../server/orderSafety.ts';
import { CONFIG_REV, EngineRunner, migrateConfig, savedConfigRev } from '../src/lib/engine/runner.ts';
import { DEFAULT_CONFIG, initialEngineState, type EngineConfig, type EngineState, type OpenPosition } from '../src/lib/engine/types.ts';

// ---------------------------------------------------------------- mock broker

type Ord = { orderId: string; type: string; side: 'BUY' | 'SELL'; qty: number; filledQty: number; status: string; avg: number; trigger?: number };

function mockBroker() {
  const orders = new Map<string, Ord>();
  let n = 0;
  const log: string[] = [];
  const m = {
    orders,
    log,
    /** 'ok' | 'timeout' (no reply, order unchanged) | 'reject' (broker error, order unchanged). */
    cancelMode: 'ok' as 'ok' | 'timeout' | 'reject',
    positionsDown: false,
    /** Called when a cancel arrives, before it is applied (e.g. the stop fires right then). */
    onCancel: null as ((o: Ord) => void) | null,
    /** Outside-the-app trades (Dhan app, auto square-off) that change the holding. */
    outside: 0,
    held: () => [...orders.values()].reduce((q, o) => q + (o.side === 'BUY' ? 1 : -1) * o.filledQty, 0) + m.outside,
    working: () => [...orders.values()].filter((o) => o.type === 'STOP_LOSS' && /PENDING|PART_TRADED/.test(o.status)),
    workingStopQty: () => m.working().reduce((q, o) => q + (o.qty - o.filledQty), 0),
    sold: () => [...orders.values()].filter((o) => o.side === 'SELL').reduce((q, o) => q + o.filledQty, 0) - m.outside * 0,
    fill(id: string, qty?: number) {
      const o = orders.get(id)!;
      o.filledQty = qty ?? o.qty;
      o.status = o.filledQty >= o.qty ? 'TRADED' : 'PART_TRADED';
      o.avg = o.trigger ?? 100;
      log.push(`exchange fills ${id} (${o.type} ${o.side} ${o.filledQty})`);
    },
    gw: {
      name: 'DHAN' as const,
      ready: () => true,
      instrument: async () => ({ securityId: '777' }),
      place: async (a: any) => {
        const id = `O${++n}`;
        const market = a.type === 'MARKET';
        orders.set(id, { orderId: id, type: a.type, side: a.side, qty: a.qty, filledQty: market ? a.qty : 0, status: market ? 'TRADED' : 'PENDING', avg: market ? 101 : 0, trigger: a.trigger });
        log.push(`place ${id} ${a.type} ${a.side} ${a.qty}${a.trigger != null ? ` @${a.trigger}` : ''}`);
        return id;
      },
      order: async (id: string) => {
        const o = orders.get(id);
        return o ? { orderId: id, orderStatus: o.status, filledQty: o.filledQty, quantity: o.qty, averageTradedPrice: o.avg } : null;
      },
      cancel: async (id: string) => {
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
        if (o.status === 'TRADED') {
          log.push(`cancel ${id} → already traded`);
          throw new Error('DH-906 Order is TRADED');
        }
        o.status = 'CANCELLED';
        log.push(`cancel ${id}`);
      },
      findRecent: async () => null,
      positions: async () => {
        if (m.positionsDown) throw new Error('Cannot reach Dhan: positions');
        return [{ securityId: '777', netQty: m.held(), product: 'INTRADAY' }];
      },
    },
  };
  return m;
}

const cfg: EngineConfig = { ...DEFAULT_CONFIG, tradeMode: 'LIVE', lotSize: 65, liveProduct: 'INTRADAY' };

/** A runner holding one live position of 650 bought at the broker, protected by a stop at 189.10. */
async function setup(o: { held?: number } = {}) {
  const b = mockBroker();
  const trader = new LiveTrader(null as never, null as never, { dhanGateway: b.gw as never, sleep: async () => {} });
  trader.reconEveryMs = 0;
  trader.flatConfirmMs = 0;
  trader.freshEntryMs = 0;
  trader.retryMs = 0;
  const runner = new EngineRunner({ load: async () => { throw new Error('unused'); } }, { load: async () => null, save: async () => {} });
  runner.config = cfg;
  runner.marketOpen = () => true;
  const entry = await b.gw.place({ type: 'MARKET', side: 'BUY', qty: o.held ?? 650 });
  const sl = await b.gw.place({ type: 'STOP_LOSS', side: 'SELL', qty: 650, trigger: 189.1 });
  const pos: OpenPosition = {
    direction: 'CE', strike: 24300, entry: 200, originalSl: 189.1, target1: 221.85, target2: 232.8, totalQty: 650, journalId: 'J1', openedAt: 0,
    partialBooked: false, partialQty: 0, partialPnl: 0, remainingQty: 650, currentSl: 189.1, side: 1, pointValue: 1, symbol: 'NIFTY',
    live: { securityId: '777', entryOrderId: entry, slOrderId: sl, slTrigger: 189.1, slQty: 650 },
  };
  const journal = [{ id: 'J1', date: '2026-11-11', time: '10:00:00', spot: 0, strike: 24300, direction: 'CE' as const, entry: 200, sl: 189.1, target: 221.85, exit: null, pnl: null, confidence: 85, trend: '', pcr: 1, oiBias: '', iv: 12, delta: 0.5, entryReason: '', exitReason: '' }];
  runner.state = { ...initialEngineState(), day: '2026-11-11', journal, position: pos } as EngineState;
  b.log.length = 0;
  return { b, trader, runner, sl, pos };
}
const st = (runner: EngineRunner, position: OpenPosition | null) => ({ ...runner.state, position }) as EngineState;
/** The engine closed the trade at its stop this cycle (journal booked at the stop level). */
async function engineExit(runner: EngineRunner, trader: LiveTrader, prev: OpenPosition) {
  const closed = { ...runner.state, position: null, journal: runner.state.journal.map((j) => ({ ...j, exit: prev.currentSl, pnl: (prev.currentSl - 200) * 650 })) } as EngineState;
  runner.state = closed;
  await trader.afterCycle(runner, st(runner, prev), closed);
}
/** No overselling, no duplicate protection — checked after every scenario. */
function invariants(b: ReturnType<typeof mockBroker>, label: string) {
  assert.ok(b.held() >= 0, `${label}: oversold — net ${b.held()}\n${b.log.join('\n')}`);
  assert.ok(b.workingStopQty() <= Math.max(0, b.held()), `${label}: working stops ${b.workingStopQty()} > held ${b.held()}\n${b.log.join('\n')}`);
  assert.ok(b.working().length <= 1, `${label}: ${b.working().length} working stops\n${b.log.join('\n')}`);
}

// ---------------------------------------------------------------- J-1: exit vs exchange stop

test('J-1 · 1. the exchange stop filled just before the app exits → no SELL, journal gets the stop fill', async () => {
  const { b, trader, runner, sl, pos } = await setup();
  b.fill(sl);
  await engineExit(runner, trader, pos);
  assert.equal([...b.orders.values()].filter((o) => o.type === 'MARKET' && o.side === 'SELL').length, 0, b.log.join('\n'));
  assert.equal(b.held(), 0);
  assert.equal(runner.state.journal[0].exit, 189.1);
  assert.match(runner.state.journal[0].exitReason, /exchange stop fill/);
  invariants(b, 'stop filled before exit');
});

test('J-1 · 2. the exchange stop fills at the same moment as the app exit (during the cancel) → no SELL', async () => {
  const { b, trader, runner, sl, pos } = await setup();
  b.onCancel = (o) => {
    if (o.orderId === sl && o.status === 'PENDING') b.fill(sl);
  };
  await engineExit(runner, trader, pos);
  assert.equal([...b.orders.values()].filter((o) => o.type === 'MARKET' && o.side === 'SELL').length, 0, b.log.join('\n'));
  assert.equal(b.held(), 0, 'sold exactly what was held, once');
  invariants(b, 'simultaneous fill');
});

test('J-1 · manual EXIT racing the exchange stop → no second SELL', async () => {
  const { b, trader, runner, sl } = await setup();
  b.onCancel = (o) => {
    if (o.orderId === sl && o.status === 'PENDING') b.fill(sl);
  };
  await trader.exit(runner);
  assert.equal(b.held(), 0, b.log.join('\n'));
  assert.equal(runner.state.position, null);
  assert.match(runner.state.journal[0].exitReason, /SL HIT \(exchange stop order\)/);
  invariants(b, 'manual exit race');
});

test('J-1 · 6. partial stop execution, then the app exits → only the remaining quantity is sold', async () => {
  const { b, trader, runner, sl, pos } = await setup();
  b.fill(sl, 325); // the stop sold 325 of 650 and is still working
  await engineExit(runner, trader, pos);
  const sells = [...b.orders.values()].filter((o) => o.type === 'MARKET' && o.side === 'SELL');
  assert.deepEqual(sells.map((o) => o.qty), [325], b.log.join('\n'));
  assert.equal(b.held(), 0);
  invariants(b, 'partial stop');
});

// ---------------------------------------------------------------- J-2: cancellation must be confirmed

test('J-2 · 3. cancel times out during an exit → nothing sold, the old stop keeps protecting, alert raised', async () => {
  const { b, trader, runner, pos } = await setup();
  b.cancelMode = 'timeout';
  await engineExit(runner, trader, pos);
  assert.equal([...b.orders.values()].filter((o) => o.type === 'MARKET' && o.side === 'SELL').length, 0, b.log.join('\n'));
  assert.equal(b.working().length, 1, 'the original stop is still the only protection');
  assert.ok(runner.state.events.some((e) => e.kind === 'ERROR' && /could not be confirmed cancelled/.test(e.message)));
  invariants(b, 'cancel timeout on exit');
});

test('J-2 · 4/5. cancel refused while raising the stop → no replacement while the old one works; retried later', async () => {
  const { b, trader, runner, pos } = await setup();
  b.cancelMode = 'reject';
  const raised = { ...pos, currentSl: 207.7 };
  runner.state = st(runner, raised);
  await trader.afterCycle(runner, st(runner, pos), st(runner, raised));
  assert.equal(b.working().length, 1, b.log.join('\n'));
  assert.equal(b.working()[0].trigger, 189.1, 'old stop untouched');
  assert.ok(runner.state.events.some((e) => e.kind === 'ERROR' && /NOT done/.test(e.message)));
  invariants(b, 'cancel refused');
  // The broker accepts the cancel next time: exactly one stop, at the new level.
  b.cancelMode = 'ok';
  await trader.afterCycle(runner, st(runner, runner.state.position), st(runner, runner.state.position));
  assert.deepEqual(b.working().map((o) => [o.trigger, o.qty]), [[207.7, 650]], b.log.join('\n'));
  assert.equal(runner.state.position!.live!.slTrigger, 207.7);
  invariants(b, 'retry after refusal');
});

test('J-2 · cancel times out at Target 1 → the half is NOT sold while the full stop still works', async () => {
  const { b, trader, runner, pos } = await setup();
  b.cancelMode = 'timeout';
  const t1 = { ...pos, partialBooked: true, partialQty: 325, partialPnl: 7100, remainingQty: 325, currentSl: 200 };
  runner.state = st(runner, t1);
  await trader.afterCycle(runner, st(runner, pos), st(runner, t1));
  assert.equal([...b.orders.values()].filter((o) => o.type === 'MARKET' && o.side === 'SELL').length, 0, b.log.join('\n'));
  assert.equal(b.workingStopQty(), 650);
  invariants(b, 'T1 with cancel timeout');
});

test('J-2 · a normal raise still works: one stop, new level, quantity = holding', async () => {
  const { b, trader, runner, pos } = await setup();
  const raised = { ...pos, currentSl: 207.7 };
  runner.state = st(runner, raised);
  await trader.afterCycle(runner, st(runner, pos), st(runner, raised));
  assert.deepEqual(b.working().map((o) => [o.trigger, o.qty]), [[207.7, 650]]);
  invariants(b, 'normal raise');
});

test('J-2 · Target 1 books half and re-protects the rest (normal path)', async () => {
  const { b, trader, runner, pos } = await setup();
  const t1 = { ...pos, partialBooked: true, partialQty: 325, partialPnl: 7100, remainingQty: 325, currentSl: 200 };
  runner.state = st(runner, t1);
  await trader.afterCycle(runner, st(runner, pos), st(runner, t1));
  assert.equal(b.held(), 325);
  assert.deepEqual(b.working().map((o) => [o.trigger, o.qty]), [[200, 325]]);
  invariants(b, 'T1');
});

test('cancelConfirmed: reads the order back; never reports CANCELLED without the broker saying so', async () => {
  const b = mockBroker();
  const id = await b.gw.place({ type: 'STOP_LOSS', side: 'SELL', qty: 65, trigger: 90 });
  b.cancelMode = 'timeout';
  assert.equal((await cancelConfirmed(b.gw, id, async () => {})).state, 'ACTIVE');
  b.cancelMode = 'ok';
  assert.equal((await cancelConfirmed(b.gw, id, async () => {})).state, 'CANCELLED');
  const id2 = await b.gw.place({ type: 'STOP_LOSS', side: 'SELL', qty: 65, trigger: 90 });
  b.fill(id2);
  const r = await cancelConfirmed(b.gw, id2, async () => {});
  assert.deepEqual([r.state, r.filledQty], ['FILLED', 65]);
  const gone = { order: async () => { throw new Error('Cannot reach Dhan'); }, cancel: async () => {} };
  assert.equal((await cancelConfirmed(gone, 'X', async () => {})).state, 'UNKNOWN');
  assert.equal(await heldQty(async () => { throw new Error('down'); }, '777', 'INTRADAY', 1, async () => {}), null, 'a failed read is unknown, never 0');
});

// ---------------------------------------------------------------- J-4: reconciliation with the broker

test('J-4 · 7. manual exit in the Dhan app → detected, our stop cancelled, trade closed, nothing sold', async () => {
  const { b, trader, runner, pos } = await setup();
  b.outside = -650; // sold in the Dhan app
  for (let i = 0; i < 2; i++) await trader.afterCycle(runner, st(runner, runner.state.position), st(runner, runner.state.position));
  assert.equal(runner.state.position, null, b.log.join('\n'));
  assert.match(runner.state.journal[0].exitReason, /CLOSED OUTSIDE THE APP/);
  assert.equal(b.working().length, 0, 'no SELL stop left for a position that is gone');
  assert.equal([...b.orders.values()].filter((o) => o.type === 'MARKET' && o.side === 'SELL').length, 0);
  assert.ok(runner.state.events.some((e) => /closed outside the app/.test(e.message)));
  void pos;
});

test('J-4 · 8. broker auto square-off (stop cancelled by the broker) → no new SELL stop for a closed position', async () => {
  const { b, trader, runner, sl } = await setup();
  b.outside = -650;
  b.orders.get(sl)!.status = 'CANCELLED';
  trader.reconEveryMs = 60_000; // the stop check, not the periodic one, sees it first
  await trader.afterCycle(runner, st(runner, runner.state.position), st(runner, runner.state.position));
  await trader.afterCycle(runner, st(runner, runner.state.position), st(runner, runner.state.position));
  assert.equal(b.working().length, 0, b.log.join('\n'));
  assert.equal(runner.state.position, null);
  invariants(b, 'auto square-off');
});

test('J-4 · partial manual exit → alert, and the stop is resized down to the holding', async () => {
  const { b, trader, runner } = await setup();
  b.outside = -325;
  await trader.afterCycle(runner, st(runner, runner.state.position), st(runner, runner.state.position));
  assert.deepEqual(b.working().map((o) => o.qty), [325], b.log.join('\n'));
  assert.ok(runner.state.events.some((e) => /holds 325/.test(e.message)));
  invariants(b, 'partial outside exit');
});

test('J-4 · 9. restart with an open position: a new trader reconciles at once and changes nothing when all agrees', async () => {
  const { b, runner } = await setup();
  const fresh = new LiveTrader(null as never, null as never, { dhanGateway: b.gw as never, sleep: async () => {} });
  await fresh.afterCycle(runner, st(runner, runner.state.position), st(runner, runner.state.position));
  assert.equal(b.log.filter((l) => /^place|^cancel/.test(l)).length, 0, b.log.join('\n'));
  assert.ok(runner.state.position);
  invariants(b, 'restart');
});

test('J-4 · 12. network down during reconciliation → nothing closed, nothing placed', async () => {
  const { b, trader, runner, sl } = await setup();
  b.positionsDown = true;
  b.outside = -650; // even if the position really is gone, an unreadable answer proves nothing
  for (let i = 0; i < 3; i++) await trader.afterCycle(runner, st(runner, runner.state.position), st(runner, runner.state.position));
  assert.ok(runner.state.position, 'not assumed closed');
  // The stop found cancelled while positions can't be read: no new stop, an alert instead.
  b.orders.get(sl)!.status = 'CANCELLED';
  await trader.afterCycle(runner, st(runner, runner.state.position), st(runner, runner.state.position));
  assert.equal(b.working().length, 0, b.log.join('\n'));
  assert.ok(runner.state.events.some((e) => /protection can't be confirmed/.test(e.message)));
});

// ---------------------------------------------------------------- J-3: settings

const USER: Partial<EngineConfig> = {
  symbol: 'NIFTY', lotSize: 65, maxLots: 10, capitalPaper: 200000, sizingMode: 'RISK', maxRisk: 20000, capitalPct: 100,
  profitLock: true, lockStart: 10000, lockStep: 7500, lockRideFrom: 15000, lockRideAmount: 6000,
  dayPlanLock: true, dl1At: 9000, dl1Lock: 5000, dl2At: 12000, dl2Lock: 7000, dl3At: 14000, dl3Lock: 10000, dayFloor: 10000,
};
const pick = (c: EngineConfig) => Object.fromEntries(Object.keys(USER).map((k) => [k, (c as any)[k]]));

function memStore(initial: any = null) {
  let saved = initial;
  return { store: { load: async () => saved, save: async (state: any, config: any) => void (saved = JSON.parse(JSON.stringify({ state, config }))) }, get: () => saved };
}
const src = { load: async () => { throw new Error('offline'); } };

test('J-3 · 10/11. fresh install → settings entered → restarts: every setting survives', async () => {
  const m = memStore();
  const a = new EngineRunner(src, m.store);
  await a.init();
  await a.updateConfig(USER);
  assert.equal(m.get().config.configRev, CONFIG_REV, 'a fresh config is saved as current');
  for (let i = 0; i < 3; i++) {
    const r = new EngineRunner(src, m.store);
    await r.init();
    assert.deepEqual(pick(r.config), USER, `restart ${i + 1}`);
    await r.updateConfig({}); // saves again
  }
});

test('J-3 · a config already saved WITHOUT configRev by a fresh install (before this fix) is not migrated', async () => {
  const { configRev: _r, ...noRev } = { ...DEFAULT_CONFIG, ...USER };
  const m = memStore({ state: initialEngineState(), config: noRev });
  const r = new EngineRunner(src, m.store);
  await r.init();
  assert.deepEqual(pick(r.config), USER);
  assert.equal(savedConfigRev(noRev), 5);
});

test('J-3 · genuine upgrades still migrate once, and migrating again changes nothing (idempotent)', async () => {
  // A rev-2 config (saved with its revision) gets the rev 3–5 updates, as before.
  const old = { ...DEFAULT_CONFIG, configRev: 2, sizingMode: 'RISK' as const, maxLots: 10, dl1At: 9000, dl1Lock: 5000, dl2At: 12000, dl2Lock: 7000, dl3At: 14000, dl3Lock: 10000 };
  const once = migrateConfig(old, old);
  assert.equal(once.configRev, CONFIG_REV);
  assert.equal(once.sizingMode, 'FIXED');
  const twice = migrateConfig(once, once);
  assert.deepEqual(twice, once);
  // Revision inference for configs missing the number.
  assert.equal(savedConfigRev({ confirmHoldSeconds: 30 }), 4);
  assert.equal(savedConfigRev({ autoShed: true }), 3);
  assert.equal(savedConfigRev({}), 1);
  assert.equal(savedConfigRev({ configRev: 0 }), 0);
});

test('J-3 · the defaults themselves are unchanged apart from carrying the revision', () => {
  assert.equal(DEFAULT_CONFIG.configRev, CONFIG_REV);
  assert.deepEqual(
    [DEFAULT_CONFIG.maxLots, DEFAULT_CONFIG.sizingMode, DEFAULT_CONFIG.maxRisk, DEFAULT_CONFIG.dl1At, DEFAULT_CONFIG.lockStart, DEFAULT_CONFIG.lockStep],
    [25, 'RISK', 2000, 9000, 10000, 5000],
  );
});
