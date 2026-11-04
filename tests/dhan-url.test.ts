/// <reference types="node" />
/**
 * Regression: the phone app passes baseUrl = undefined (no test URL configured). That must
 * still call the real Dhan API, not "undefined/profile".
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DHAN_API_URL, DhanClient } from '../server/dhan.ts';
import { verifyDhanCredentials } from '../src/api/localApi.ts';

test('DhanClient: missing / undefined / empty baseUrl → the real Dhan API', async () => {
  const seen: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ dhanClientId: '1', tokenValidity: '31/12/2099 09:00' }), { status: 200 });
  }) as typeof fetch;
  try {
    for (const baseUrl of [undefined, '']) {
      await new DhanClient({ clientId: '1', accessToken: 't', baseUrl }).profile();
    }
    await new DhanClient({ clientId: '1', accessToken: 't' }).profile();
    await verifyDhanCredentials('1', 't', undefined).catch(() => {});
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(DHAN_API_URL, 'https://api.dhan.co/v2');
  assert.ok(seen.length >= 4);
  for (const u of seen) assert.ok(u.startsWith('https://api.dhan.co/v2/'), u);
});
