/**
 * License keys for the licensed copy of the app (Nifty Trader v1).
 *
 * A key says "this phone (App ID) may use the app until day X", signed with the owner's secret
 * key (Ed25519). The licensed app holds only the public key: it can check keys but never make
 * them, so the app can be given away safely — keys come from the owner's own app (Settings →
 * License keys). A key works on one phone only; when it ends, the owner makes a new one.
 *
 * Pure (tweetnacl only) so the same file runs in both apps and in tests.
 */
import nacl from 'tweetnacl';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function b64uEncode(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < b.length) out += B64[(n >> 6) & 63];
    if (i + 2 < b.length) out += B64[n & 63];
  }
  return out;
}

export function b64uDecode(s: string): Uint8Array {
  const clean = s.replace(/[\s=]/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error('The key has a character that does not belong in it');
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 255);
    }
  }
  return Uint8Array.from(out);
}

const DAY0 = Date.UTC(2024, 0, 1);
const IST = 5.5 * 3600_000;
/** Days since 2024-01-01 of the IST date of `ms`. */
export const dayOf = (ms: number) => Math.floor((ms + IST - DAY0) / 86400_000);
/** "2026-12-10" for a day number. */
export const dayLabel = (d: number) => new Date(DAY0 + d * 86400_000).toISOString().slice(0, 10);
/** End of an IST day (ms): the key works through that whole day. */
export const dayEnd = (d: number) => DAY0 + (d + 1) * 86400_000 - IST - 1;

const DOMAIN = new TextEncoder().encode('NTV1-LICENSE');
const KEY_PREFIX = 'NT1-';
const SECRET_PREFIX = 'NTSK-';

/** App ID: 8 random bytes, shown as AB12-CD34-EF56-7890. */
export function formatAppId(id: Uint8Array): string {
  const h = [...id].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  return h.match(/.{4}/g)!.join('-');
}

export function parseAppId(s: string): Uint8Array {
  const h = s.replace(/[\s-]/g, '').toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(h)) throw new Error('App ID must be 16 letters / digits, like AB12-CD34-EF56-7890');
  return Uint8Array.from(h.match(/.{2}/g)!.map((x) => parseInt(x, 16)));
}

/** Random bytes for an App ID (uniqueness only — React Native may have no crypto PRNG). */
function someRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(out);
  else for (let i = 0; i < n; i++) out[i] = (Math.floor(Math.random() * 256) ^ (Date.now() >> (i % 8))) & 255;
  return out;
}

export function newAppId(random: (n: number) => Uint8Array = someRandom): string {
  return formatAppId(random(8));
}

export interface LicenseInfo {
  appId: string;
  issuedDay: number;
  expiryDay: number;
  /** "2026-12-10" — the last day the key works. */
  expires: string;
}

const payloadOf = (appId: Uint8Array, issuedDay: number, expiryDay: number) => {
  const p = new Uint8Array(13);
  p[0] = 1;
  p.set(appId, 1);
  p[9] = (issuedDay >> 8) & 255;
  p[10] = issuedDay & 255;
  p[11] = (expiryDay >> 8) & 255;
  p[12] = expiryDay & 255;
  return p;
};

const signed = (payload: Uint8Array) => {
  const m = new Uint8Array(DOMAIN.length + payload.length);
  m.set(DOMAIN);
  m.set(payload, DOMAIN.length);
  return m;
};

/** The owner's secret key ("NTSK-…", 32-byte seed) → signing key pair. */
export function ownerKeyPair(secret: string): nacl.SignKeyPair {
  const s = secret.trim();
  if (!s.startsWith(SECRET_PREFIX)) throw new Error('Not a secret key (it starts with NTSK-)');
  const seed = b64uDecode(s.slice(SECRET_PREFIX.length));
  if (seed.length !== 32) throw new Error('The secret key is incomplete — copy all of it');
  return nacl.sign.keyPair.fromSeed(seed);
}

export const publicKeyOf = (secret: string) => b64uEncode(ownerKeyPair(secret).publicKey);

/** Make a key for an App ID, valid `days` days from today (today counts as day 1). */
export function makeLicense(secret: string, appId: string, days: number, now = Date.now()): { key: string; info: LicenseInfo } {
  if (!Number.isInteger(days) || days < 1 || days > 400) throw new Error('Days must be 1–400');
  const id = parseAppId(appId);
  const issuedDay = dayOf(now);
  const expiryDay = issuedDay + days - 1;
  const payload = payloadOf(id, issuedDay, expiryDay);
  const sig = nacl.sign.detached(signed(payload), ownerKeyPair(secret).secretKey);
  const all = new Uint8Array(payload.length + sig.length);
  all.set(payload);
  all.set(sig, payload.length);
  return { key: KEY_PREFIX + b64uEncode(all), info: { appId: formatAppId(id), issuedDay, expiryDay, expires: dayLabel(expiryDay) } };
}

export type LicenseCheck =
  | { ok: true; info: LicenseInfo; daysLeft: number }
  | { ok: false; reason: string; info?: LicenseInfo };

/** Check a key against this phone's App ID, the owner's public key and the time. */
export function checkLicense(key: string, appId: string, publicKey: string, now = Date.now()): LicenseCheck {
  const k = key.replace(/\s/g, '');
  if (!k.startsWith(KEY_PREFIX)) return { ok: false, reason: 'Not a license key (it starts with NT1-)' };
  let raw: Uint8Array;
  try {
    raw = b64uDecode(k.slice(KEY_PREFIX.length));
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  if (raw.length !== 13 + 64 || raw[0] !== 1) return { ok: false, reason: 'The key is incomplete — copy all of it' };
  const payload = raw.slice(0, 13);
  const sig = raw.slice(13);
  if (!nacl.sign.detached.verify(signed(payload), sig, b64uDecode(publicKey))) return { ok: false, reason: 'This key is not valid' };
  const info: LicenseInfo = {
    appId: formatAppId(payload.slice(1, 9)),
    issuedDay: (payload[9] << 8) | payload[10],
    expiryDay: (payload[11] << 8) | payload[12],
    expires: dayLabel((payload[11] << 8) | payload[12]),
  };
  if (info.appId !== formatAppId(parseAppId(appId))) return { ok: false, reason: 'This key is for another phone (App ID differs)', info };
  if (now > dayEnd(info.expiryDay)) return { ok: false, reason: `This key ended on ${info.expires}`, info };
  if (now < dayEnd(info.issuedDay) - 2 * 86400_000) return { ok: false, reason: "The phone's date is wrong (before the key was made)", info };
  return { ok: true, info, daysLeft: info.expiryDay - dayOf(now) + 1 };
}
