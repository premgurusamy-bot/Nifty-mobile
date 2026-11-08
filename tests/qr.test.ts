/// <reference types="node" />
/** QR setup: an otpauth:// QR gives the TOTP key (and often the client ID / code). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { otpauthInfo, parseTotpKey, totpNow } from '../src/lib/totp.ts';

test('otpauth QR → key, account and issuer', () => {
  const uri = 'otpauth://totp/AngelOne:A123456?secret=JBSWY3DPEHPK3PXP&issuer=AngelOne&period=30';
  assert.equal(parseTotpKey(uri), 'JBSWY3DPEHPK3PXP');
  assert.deepEqual(otpauthInfo(uri), { account: 'A123456', issuer: 'AngelOne' });
  assert.deepEqual(otpauthInfo('otpauth://totp/1100000001?secret=JBSWY3DPEHPK3PXP'), { account: '1100000001', issuer: '' });
  assert.deepEqual(otpauthInfo('otpauth://totp/Dhan%3A1100000001?secret=X'), { account: '1100000001', issuer: 'Dhan' });
  assert.equal(otpauthInfo('https://example.com'), null);
  assert.equal(totpNow(uri, 59_000), totpNow('JBSWY3DPEHPK3PXP', 59_000));
  assert.throws(() => parseTotpKey('https://example.com/not-a-totp'), /letters-and-digits/);
});
