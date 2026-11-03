/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BROKERAGE_PER_ORDER,
  STARTING_CASH,
  cancelOrder,
  initialPortfolio,
  matchOpenOrders,
  placeOrder,
  summarize,
} from '../src/lib/portfolio.ts';
import { NIFTY_LOT_SIZE } from '../src/lib/instruments.ts';

const REL = 'NSE:RELIANCE';
const prices = (p: Record<string, number>) => (id: string) => p[id] ?? null;
let n = 0;
const id = () => `o${++n}`;

test('market buy fills at LTP and charges brokerage', () => {
  const s = placeOrder(
    initialPortfolio(),
    { instrumentId: REL, side: 'BUY', qty: 10, type: 'MARKET' },
    prices({ [REL]: 1500 }),
    0,
    id(),
  );
  assert.equal(s.orders[0].status, 'FILLED');
  assert.equal(s.orders[0].fillPrice, 1500);
  assert.deepEqual(s.positions[REL], { qty: 10, avgPrice: 1500 });
  assert.equal(s.cash, STARTING_CASH - 15000 - BROKERAGE_PER_ORDER);
});

test('averaging up and partial sell realises P&L', () => {
  let s = initialPortfolio();
  s = placeOrder(s, { instrumentId: REL, side: 'BUY', qty: 10, type: 'MARKET' }, prices({ [REL]: 100 }), 0, id());
  s = placeOrder(s, { instrumentId: REL, side: 'BUY', qty: 10, type: 'MARKET' }, prices({ [REL]: 200 }), 0, id());
  assert.equal(s.positions[REL].avgPrice, 150);
  s = placeOrder(s, { instrumentId: REL, side: 'SELL', qty: 5, type: 'MARKET' }, prices({ [REL]: 170 }), 0, id());
  assert.equal(s.realizedPnl, 100);
  assert.equal(s.positions[REL].qty, 15);
  s = placeOrder(s, { instrumentId: REL, side: 'SELL', qty: 15, type: 'MARKET' }, prices({ [REL]: 150 }), 0, id());
  assert.equal(s.positions[REL], undefined);
  assert.equal(s.charges, 4 * BROKERAGE_PER_ORDER);
});

test('cannot sell what you do not hold', () => {
  const s = placeOrder(
    initialPortfolio(),
    { instrumentId: REL, side: 'SELL', qty: 1, type: 'MARKET' },
    prices({ [REL]: 100 }),
    0,
    id(),
  );
  assert.equal(s.orders[0].status, 'REJECTED');
  assert.equal(s.cash, STARTING_CASH);
});

test('rejects when funds are insufficient', () => {
  const s = placeOrder(
    initialPortfolio(),
    { instrumentId: REL, side: 'BUY', qty: 1000, type: 'MARKET' },
    prices({ [REL]: 1500 }),
    0,
    id(),
  );
  assert.equal(s.orders[0].status, 'REJECTED');
  assert.match(s.orders[0].reason!, /funds/i);
});

test('option quantity must be a lot multiple', () => {
  const opt = 'NFO:NIFTY:2026-11-10:26000:CE';
  const bad = placeOrder(
    initialPortfolio(),
    { instrumentId: opt, side: 'BUY', qty: 10, type: 'MARKET' },
    prices({ [opt]: 100 }),
    0,
    id(),
  );
  assert.equal(bad.orders[0].status, 'REJECTED');
  const ok = placeOrder(
    initialPortfolio(),
    { instrumentId: opt, side: 'BUY', qty: NIFTY_LOT_SIZE, type: 'MARKET' },
    prices({ [opt]: 100 }),
    0,
    id(),
  );
  assert.equal(ok.orders[0].status, 'FILLED');
});

test('limit buy rests until price crosses, then fills at LTP', () => {
  let s = placeOrder(
    initialPortfolio(),
    { instrumentId: REL, side: 'BUY', qty: 1, type: 'LIMIT', limitPrice: 95 },
    prices({ [REL]: 100 }),
    0,
    id(),
  );
  assert.equal(s.orders[0].status, 'OPEN');
  s = matchOpenOrders(s, prices({ [REL]: 96 }), 1);
  assert.equal(s.orders[0].status, 'OPEN');
  s = matchOpenOrders(s, prices({ [REL]: 94.5 }), 2);
  assert.equal(s.orders[0].status, 'FILLED');
  assert.equal(s.orders[0].fillPrice, 94.5);
});

test('open orders can be cancelled', () => {
  let s = placeOrder(
    initialPortfolio(),
    { instrumentId: REL, side: 'BUY', qty: 1, type: 'LIMIT', limitPrice: 50 },
    prices({ [REL]: 100 }),
    0,
    id(),
  );
  s = cancelOrder(s, s.orders[0].id, 1);
  assert.equal(s.orders[0].status, 'CANCELLED');
  s = matchOpenOrders(s, prices({ [REL]: 10 }), 2);
  assert.equal(s.orders[0].status, 'CANCELLED');
});

test('summary marks positions to market', () => {
  const s = placeOrder(
    initialPortfolio(),
    { instrumentId: REL, side: 'BUY', qty: 10, type: 'MARKET' },
    prices({ [REL]: 100 }),
    0,
    id(),
  );
  const sum = summarize(s, prices({ [REL]: 110 }));
  assert.equal(sum.unrealizedPnl, 100);
  assert.equal(sum.equity, STARTING_CASH - BROKERAGE_PER_ORDER + 100);
});
