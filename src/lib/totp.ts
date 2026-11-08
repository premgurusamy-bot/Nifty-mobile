/**
 * TOTP (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits), so the app can make Dhan's login
 * code itself from the TOTP key saved once — the same thing an authenticator app does.
 * Pure JS: React Native's Hermes engine has no WebCrypto.
 */

/** Accepts the plain key ("JBSW Y3DP …") or an otpauth:// URI from Dhan's QR code. */
export function parseTotpKey(input: string): string {
  let s = input.trim();
  if (/^otpauth:\/\//i.test(s)) {
    const m = /[?&]secret=([^&]+)/i.exec(s);
    if (!m) throw new Error('That QR link has no secret in it.');
    s = decodeURIComponent(m[1]);
  }
  s = s.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (s.length < 16 || !/^[A-Z2-7]+$/.test(s))
    throw new Error('The TOTP key is the letters-and-digits code (A–Z, 2–7) shown when you set up TOTP.');
  return s;
}

/** From an otpauth:// QR: the account name (often your client ID / code) and the issuer. */
export function otpauthInfo(uri: string): { account: string; issuer: string } | null {
  const m = /^otpauth:\/\/totp\/([^?]*)(\?.*)?$/i.exec(uri.trim());
  if (!m) return null;
  const label = decodeURIComponent(m[1]);
  const issuerQ = /[?&]issuer=([^&]+)/i.exec(m[2] ?? '');
  const [pre, acc] = label.includes(':') ? label.split(':', 2) : ['', label];
  return { account: acc.trim(), issuer: (issuerQ ? decodeURIComponent(issuerQ[1]) : pre).trim() };
}

export function base32Decode(key: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of key.replace(/=+$/, '').toUpperCase()) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new Error('Invalid TOTP key');
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

function sha1(msg: Uint8Array): Uint8Array {
  const ml = msg.length;
  const withPad = new Uint8Array(((ml + 9 + 63) >> 6) << 6);
  withPad.set(msg);
  withPad[ml] = 0x80;
  const bitLen = ml * 8;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, Math.floor(bitLen / 2 ** 32));
  dv.setUint32(withPad.length - 4, bitLen >>> 0);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      const [f, k] =
        i < 20
          ? [(b & c) | (~b & d), 0x5a827999]
          : i < 40
            ? [b ^ c ^ d, 0x6ed9eba1]
            : i < 60
              ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
              : [b ^ c ^ d, 0xca62c1d6];
      const t = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30) >>> 0;
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const ov = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => ov.setUint32(i * 4, h));
  return out;
}

export function hmacSha1(key: Uint8Array, msg: Uint8Array): Uint8Array {
  let k = key.length > 64 ? sha1(key) : key;
  const block = new Uint8Array(64);
  block.set(k);
  k = block;
  const ipad = new Uint8Array(64 + msg.length);
  const opad = new Uint8Array(64 + 20);
  for (let i = 0; i < 64; i++) {
    ipad[i] = k[i] ^ 0x36;
    opad[i] = k[i] ^ 0x5c;
  }
  ipad.set(msg, 64);
  opad.set(sha1(ipad), 64);
  return sha1(opad);
}

/** HOTP/TOTP code for raw key bytes at `ms` (6 digits unless told otherwise). */
export function totpFromBytes(key: Uint8Array, ms = Date.now(), digits = 6, stepSeconds = 30): string {
  const counter = Math.floor(ms / 1000 / stepSeconds);
  const msg = new Uint8Array(8);
  const dv = new DataView(msg.buffer);
  dv.setUint32(0, Math.floor(counter / 2 ** 32));
  dv.setUint32(4, counter >>> 0);
  const h = hmacSha1(key, msg);
  const o = h[19] & 0xf;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** The current 6-digit code for a base32 TOTP key. */
export const totpNow = (key: string, ms = Date.now()) => totpFromBytes(base32Decode(parseTotpKey(key)), ms);
