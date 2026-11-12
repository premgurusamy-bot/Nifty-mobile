// Test-only: prepares a licensed-v1 checkout (after apply.mjs) to run its test suite with the
// audit fixes J-1..J-4, exactly as v2's tests were updated:
//   node test-patches.mjs <v1 dir> <this repo's dir>
// - the fake Dhan server gets realistic positions (from the traded orders), refuses to cancel a
//   traded order, and can simulate a dropped connection — like v2's tests/fakeDhan.ts;
// - two live fixtures get the holding a real account has (the entry was bought);
// - the hold-migration test expects J-3 (a licensed-v1 config without a revision is current);
// - order-safety.v1.test.ts: the J-1..J-4 regression tests for v1 (mock Dhan, no network);
// - loss-block.v1.test.ts: the "Clear block" tests.
// Nothing here goes into the APK.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [v1, src] = process.argv.slice(2);
if (!v1 || !src) throw new Error('usage: node test-patches.mjs <v1 dir> <source dir>');

function patch(file, from, to) {
  const path = join(v1, file);
  const text = readFileSync(path, 'utf8');
  if (text.includes(to)) return;
  if (text.split(from).length !== 2) throw new Error(`${file}: expected text not found once: ${from.slice(0, 70)}`);
  writeFileSync(path, text.replace(from, to));
}

// ---- tests/fakeDhan.ts ----
patch(
  'tests/fakeDhan.ts',
  '    nextId: 5000,\n',
  '    nextId: 5000,\n    /** Positions endpoint fails like a dropped connection (HTTP 503). */\n    positionsDown: false,\n',
);
patch(
  'tests/fakeDhan.ts',
  "      if (req.method === 'GET' && path === '/positions') {\n        return send(200, [",
  `      if (req.method === 'GET' && path === '/positions') {
        if (state.positionsDown) return send(503, { errorCode: 'DH-908', errorMessage: 'Service unavailable' });
        // F&O / MCX positions come from the traded quantities of the orders (like Dhan's own book).
        const net = new Map<string, any>();
        for (const o of state.orders) {
          const q = Number(o.filledQty) || 0;
          if (!q || o.exchangeSegment === 'NSE_EQ') continue;
          const k = \`\${o.securityId}|\${o.productType}\`;
          const r = net.get(k) ?? { securityId: String(o.securityId), productType: o.productType, exchangeSegment: o.exchangeSegment, buy: 0, sell: 0, sellValue: 0 };
          if (o.transactionType === 'BUY') r.buy += q;
          else {
            r.sell += q;
            r.sellValue += q * (Number(o.averageTradedPrice) || 0);
          }
          net.set(k, r);
        }
        const fno = [...net.values()].map((r) => ({
          dhanClientId: FAKE_CLIENT,
          securityId: r.securityId,
          exchangeSegment: r.exchangeSegment,
          productType: r.productType,
          buyQty: r.buy,
          sellQty: r.sell,
          sellAvg: r.sell ? r.sellValue / r.sell : 0,
          netQty: r.buy - r.sell,
        }));
        return send(200, [
          ...fno,`,
);
patch(
  'tests/fakeDhan.ts',
  "        if (!o) return send(404, { errorCode: 'DH-905', errorMessage: 'Order not found' });\n        o.orderStatus = 'CANCELLED';",
  `        if (!o) return send(404, { errorCode: 'DH-905', errorMessage: 'Order not found' });
        // Like Dhan: a traded or already-closed order can't be cancelled.
        if (o.orderStatus === 'TRADED' || o.orderStatus === 'CANCELLED' || o.orderStatus === 'REJECTED')
          return send(400, { errorCode: 'DH-906', errorMessage: \`Order is \${o.orderStatus}\` });
        o.orderStatus = 'CANCELLED';`,
);
patch(
  'tests/fakeDhan.ts',
  'export function startFakeDhan(',
  `/** Test helper: make the fake account hold exactly \`qty\` (net) of an F&O instrument. */
export function setHolding(state: any, securityId: string, qty: number, productType = 'INTRADAY') {
  let net = 0;
  for (const o of state.orders)
    if (String(o.securityId) === securityId && o.productType === productType && o.exchangeSegment !== 'NSE_EQ')
      net += (o.transactionType === 'BUY' ? 1 : -1) * (Number(o.filledQty) || 0);
  const diff = qty - net;
  if (!diff) return;
  state.orders.push({ orderId: String(state.nextId++), orderStatus: 'TRADED', transactionType: diff > 0 ? 'BUY' : 'SELL', exchangeSegment: 'NSE_FNO', productType, orderType: 'MARKET', securityId, quantity: Math.abs(diff), filledQty: Math.abs(diff), averageTradedPrice: 100 });
}

export function startFakeDhan(`,
);

// ---- live fixtures: the account holds what was bought ----
patch('tests/phone.test.ts', "import { FAKE_CLIENT, FAKE_TOKEN, GOLDEN_EXPIRY, startFakeDhan } from './fakeDhan.ts';", "import { FAKE_CLIENT, FAKE_TOKEN, GOLDEN_EXPIRY, setHolding, startFakeDhan } from './fakeDhan.ts';");
patch('tests/phone.test.ts', '  runner.state = afterState;\n  const n = ordersSent().length;', "  runner.state = afterState;\n  setHolding(fake.state, '70483', 130); // the account holds the 130 bought at entry\n  const n = ordersSent().length;");
patch(
  'tests/phone.test.ts',
  '  assert.equal(runner.state.position!.live!.slOrderId, String(Number(slRes.orderId) + 2));',
  '  // The position now carries the new stop (the last order placed).\n  assert.equal(runner.state.position!.live!.slOrderId, fake.state.orders.at(-1).orderId);',
);
patch('tests/profitlock.test.ts', "import { FAKE_CLIENT, FAKE_TOKEN, startFakeDhan } from './fakeDhan.ts';", "import { FAKE_CLIENT, FAKE_TOKEN, setHolding, startFakeDhan } from './fakeDhan.ts';");
patch('tests/profitlock.test.ts', '  runner.state = afterS;\n', "  runner.state = afterS;\n  setHolding(fake.state, '70483', 500); // the account holds the 500 still open\n");

// ---- J-3 in the licensed v1: a saved config without a revision is current (never migrated) ----
patch(
  'tests/hold.test.ts',
  "  const a = await make({ ...DEFAULT_CONFIG, confirmHoldMinutes: 5, configRev: undefined });\n  assert.equal(a.now, 3);",
  "  // Licensed v1 (audit J-3): every config it saved is current, so a missing revision keeps your 5.\n  const a = await make({ ...DEFAULT_CONFIG, confirmHoldMinutes: 5, configRev: undefined });\n  assert.equal(a.now, 5);",
);
patch(
  'tests/hold.test.ts',
  '  assert.equal((await make({ ...old, configRev: undefined })).now, 3);',
  '  assert.equal((await make({ ...old, configRev: undefined })).now, 3); // no saved value: the default\n  // A genuine pre-revision config (revision 0) still gets the one-time update.\n  assert.equal((await make({ ...DEFAULT_CONFIG, confirmHoldMinutes: 5, configRev: 0 })).now, 3);',
);

copyFileSync(join(src, 'editions/v1-licensed/order-safety.v1.test.ts'), join(v1, 'tests/order-safety.v1.test.ts'));
copyFileSync(join(src, 'editions/v1-licensed/loss-block.v1.test.ts'), join(v1, 'tests/loss-block.v1.test.ts'));
copyFileSync(join(src, 'tests/market-memory.test.ts'), join(v1, 'tests/market-memory.v1.test.ts'));
copyFileSync(join(src, 'tests/chart-pine.test.ts'), join(v1, 'tests/chart-pine.v1.test.ts'));
console.log('v1 test patches applied');
