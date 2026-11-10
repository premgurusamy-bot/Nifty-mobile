/// <reference types="node" />
/** License keys for the licensed v1 copy: made with the secret key, checked with the public key. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import nacl from 'tweetnacl';
import { b64uDecode, b64uEncode, checkLicense, dayEnd, dayOf, makeLicense, newAppId, parseAppId, publicKeyOf } from '../src/lib/license.ts';

// A throwaway key pair for the tests (never the owner's).
const seed = new Uint8Array(32).map((_, i) => i * 7 + 3);
const SECRET = `NTSK-${b64uEncode(seed)}`;
const PUB = b64uEncode(nacl.sign.keyPair.fromSeed(seed).publicKey);
const ist = (d: string) => Date.parse(`${d}+05:30`);
const ID = 'AB12-CD34-EF56-7890';

test('base64url round trip, App IDs', () => {
  for (const n of [0, 1, 2, 3, 31, 77]) {
    const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
    assert.deepEqual(b64uDecode(b64uEncode(b)), b);
  }
  assert.match(newAppId(), /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
  assert.equal(parseAppId('ab12cd34ef567890').length, 8);
  assert.throws(() => parseAppId('XYZ'), /16 letters/);
  assert.equal(publicKeyOf(SECRET), PUB);
});

test('a 30-day key works on its phone through the 30th day, then ends', () => {
  const made = ist('2026-11-10T10:00:00');
  const { key, info } = makeLicense(SECRET, ID, 30, made);
  assert.match(key, /^NT1-[A-Za-z0-9_-]+$/);
  assert.equal(info.expires, '2026-12-09');
  const ok = checkLicense(key, 'ab12cd34ef567890', PUB, ist('2026-11-10T11:00:00'));
  assert.ok(ok.ok && ok.daysLeft === 30, JSON.stringify(ok));
  const lastDay = checkLicense(key, ID, PUB, ist('2026-12-09T23:59:00'));
  assert.ok(lastDay.ok && lastDay.daysLeft === 1);
  const ended = checkLicense(key, ID, PUB, ist('2026-12-10T00:00:30'));
  assert.equal(ended.ok, false);
  assert.match((ended as { reason: string }).reason, /ended on 2026-12-09/);
  assert.equal(dayEnd(dayOf(made)) > made, true);
});

test('another phone, a changed key, a wrong signer or a date set back are refused', () => {
  const now = ist('2026-11-10T10:00:00');
  const { key } = makeLicense(SECRET, ID, 30, now);
  assert.match((checkLicense(key, '0000-0000-0000-0001', PUB, now) as { reason: string }).reason, /another phone/);
  // Change one character in the middle (e.g. trying to stretch the date).
  const i = 10;
  const bad = key.slice(0, i) + (key[i] === 'A' ? 'B' : 'A') + key.slice(i + 1);
  assert.equal(checkLicense(bad, ID, PUB, now).ok, false);
  const other = b64uEncode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)).publicKey);
  assert.match((checkLicense(key, ID, other, now) as { reason: string }).reason, /not valid/);
  assert.match((checkLicense(key, ID, PUB, ist('2026-10-01T10:00:00')) as { reason: string }).reason, /date is wrong/);
  assert.match((checkLicense('hello', ID, PUB, now) as { reason: string }).reason, /NT1-/);
  assert.match((checkLicense(key.slice(0, 40), ID, PUB, now) as { reason: string }).reason, /incomplete/);
  assert.throws(() => makeLicense('NTSK-abc', ID, 30), /incomplete/);
  assert.throws(() => makeLicense(SECRET, ID, 0), /1–400/);
});
