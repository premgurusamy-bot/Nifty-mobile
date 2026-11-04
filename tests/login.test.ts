/// <reference types="node" />
/** Dhan login (client ID + 6-digit PIN, TOTP made from the saved key), logout, and the login safety rules. */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { dhanPinLogin } from '../server/dhan.ts';
import { verifyDhanCredentials } from '../src/api/localApi.ts';
import { loginSafety, logoutSafety } from '../src/lib/session.ts';
import { base32Decode, parseTotpKey, totpFromBytes, totpNow } from '../src/lib/totp.ts';
import { FAKE_CLIENT, FAKE_PIN, FAKE_TOKEN, FAKE_TOTP_KEY, startFakeDhan } from './fakeDhan.ts';

test('TOTP matches the RFC 6238 test vectors (SHA-1)', () => {
  const key = new TextEncoder().encode('12345678901234567890');
  const v: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [t, want] of v) assert.equal(totpFromBytes(key, t * 1000, 8), want);
  // same key as base32, 6 digits
  assert.equal(totpNow('GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ', 59_000), '287082');
  assert.deepEqual([...base32Decode('MZXW6===')].map((b) => String.fromCharCode(b)).join(''), 'foo');
});

test('TOTP key input: spaces, lowercase and otpauth:// links accepted; junk refused', () => {
  assert.equal(parseTotpKey(' jbsw y3dp ehpk 3pxp '), 'JBSWY3DPEHPK3PXP');
  assert.equal(parseTotpKey('otpauth://totp/Dhan:1100000001?secret=JBSWY3DPEHPK3PXP&issuer=Dhan'), 'JBSWY3DPEHPK3PXP');
  assert.throws(() => parseTotpKey('123456'), /TOTP key/);
  assert.throws(() => parseTotpKey('otpauth://totp/x?issuer=Dhan'), /no secret/);
});

let fake: Awaited<ReturnType<typeof startFakeDhan>>;
let authUrl = '';
before(async () => {
  fake = await startFakeDhan();
  authUrl = fake.url.replace(/\/v2$/, '');
});
after(() => fake.server.close());

test('client ID + PIN + the code made from the saved key → a working 24-hour token', async () => {
  const totp = totpNow(FAKE_TOTP_KEY);
  const r = await dhanPinLogin({ clientId: FAKE_CLIENT, pin: FAKE_PIN, totp, authUrl });
  assert.equal(r.accessToken, FAKE_TOKEN);
  assert.equal(r.expiry, '2099-12-31T09:00:00');
  const req = fake.requests.at(-1)!;
  assert.equal(req.method, 'POST');
  assert.equal(req.path, `/app/generateAccessToken?dhanClientId=1100000001&pin=123456&totp=${totp}`);
  assert.ok((await verifyDhanCredentials(FAKE_CLIENT, r.accessToken, fake.url)) > 0);
});

test('wrong PIN or wrong key is refused by Dhan; bad input is caught before calling Dhan', async () => {
  await assert.rejects(
    dhanPinLogin({ clientId: FAKE_CLIENT, pin: '999999', totp: totpNow(FAKE_TOTP_KEY), authUrl }),
    /Dhan login failed: Invalid PIN or TOTP/,
  );
  await assert.rejects(
    dhanPinLogin({ clientId: FAKE_CLIENT, pin: FAKE_PIN, totp: totpNow('GEZDGNBVGY3TQOJQGEZDGNBV'), authUrl }),
    /Dhan login failed/,
  );
  const n = fake.state.logins;
  await assert.rejects(dhanPinLogin({ clientId: 'abc', pin: FAKE_PIN, totp: '000000', authUrl }), /client ID/);
  await assert.rejects(dhanPinLogin({ clientId: FAKE_CLIENT, pin: '1234', totp: '000000', authUrl }), /6-digit Dhan PIN/);
  assert.equal(fake.state.logins, n);
  await assert.rejects(
    dhanPinLogin({ clientId: FAKE_CLIENT, pin: FAKE_PIN, totp: '000000', authUrl: 'http://127.0.0.1:9' }),
    /Cannot reach Dhan login/,
  );
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
