/// <reference types="node" />
/** Dhan login (client ID + PIN + TOTP), logout, and the safety rules when the login changes. */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { dhanPinLogin } from '../server/dhan.ts';
import { verifyDhanCredentials } from '../src/api/localApi.ts';
import { loginSafety, logoutSafety } from '../src/lib/session.ts';
import { FAKE_CLIENT, FAKE_PIN, FAKE_TOKEN, FAKE_TOTP, startFakeDhan } from './fakeDhan.ts';

let fake: Awaited<ReturnType<typeof startFakeDhan>>;
let authUrl = '';
before(async () => {
  fake = await startFakeDhan();
  authUrl = fake.url.replace(/\/v2$/, '');
});
after(() => fake.server.close());

test('PIN + TOTP login returns a working 24-hour token', async () => {
  const r = await dhanPinLogin({ clientId: FAKE_CLIENT, pin: FAKE_PIN, totp: '246 810', authUrl });
  assert.equal(r.accessToken, FAKE_TOKEN);
  assert.equal(r.expiry, '2099-12-31T09:00:00');
  const req = fake.requests.at(-1)!;
  assert.equal(req.method, 'POST');
  assert.match(req.path, /^\/app\/generateAccessToken\?dhanClientId=1100000001&pin=1234&totp=246810$/);
  // the token is accepted by the data API
  assert.ok((await verifyDhanCredentials(FAKE_CLIENT, r.accessToken, fake.url)) > 0);
});

test('wrong PIN / TOTP shows Dhan’s reason; bad input is caught before calling Dhan', async () => {
  await assert.rejects(dhanPinLogin({ clientId: FAKE_CLIENT, pin: '9999', totp: FAKE_TOTP, authUrl }), /^Error: Dhan login failed: Invalid PIN or TOTP$/);
  const n = fake.state.logins;
  await assert.rejects(dhanPinLogin({ clientId: 'abc', pin: FAKE_PIN, totp: FAKE_TOTP, authUrl }), /client ID/);
  await assert.rejects(dhanPinLogin({ clientId: FAKE_CLIENT, pin: '12', totp: FAKE_TOTP, authUrl }), /PIN/);
  await assert.rejects(dhanPinLogin({ clientId: FAKE_CLIENT, pin: FAKE_PIN, totp: '12345', authUrl }), /6-digit TOTP/);
  assert.equal(fake.state.logins, n);
  await assert.rejects(dhanPinLogin({ clientId: FAKE_CLIENT, pin: FAKE_PIN, totp: FAKE_TOTP, authUrl: 'http://127.0.0.1:9' }), /Cannot reach Dhan login/);
});

const live = { config: { tradeMode: 'LIVE' as const, autoEntryLive: true }, position: null };

test('every login turns automatic LIVE entries off; same account stays LIVE', () => {
  assert.deepEqual(loginSafety(live, '1100000001', '1100000001'), { patch: { autoEntryLive: false }, toPaper: false });
  assert.deepEqual(loginSafety(null, null, '1100000001'), { patch: { autoEntryLive: false }, toPaper: false });
});

test('a different account goes to PAPER, and is refused while the old account has an open position', () => {
  assert.deepEqual(loginSafety(live, '1100000001', '1100000002'), { patch: { autoEntryLive: false }, toPaper: true });
  assert.throws(
    () => loginSafety({ ...live, position: { live: undefined } }, '1100000001', '1100000002'),
    /position from Dhan client •••••••001 is still open/,
  );
});

test('logout: PAPER + automatic off; refused while a LIVE position is open', () => {
  assert.deepEqual(logoutSafety(live), { patch: { autoEntryLive: false }, toPaper: true });
  assert.deepEqual(logoutSafety({ config: { tradeMode: 'PAPER', autoEntryLive: false }, position: { live: undefined } }), {
    patch: { autoEntryLive: false },
    toPaper: false,
  });
  assert.throws(
    () => logoutSafety({ ...live, position: { live: { securityId: '1', entryOrderId: 'E', slOrderId: 'S' } } }),
    /Exit the open LIVE position before logging out/,
  );
});
