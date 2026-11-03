/// <reference types="node" />
/**
 * Keeps the Dhan access token alive.
 *
 * - On start: GET /v2/profile to confirm the token works and read its validity.
 * - Renews (GET /v2/RenewToken) ~2 h before expiry, or every 20 h when the
 *   expiry can't be read, then writes the new token back to server/.env so a
 *   restart keeps working.
 *
 * Renewal only extends a token that is still valid. If the token has already
 * expired, generate a new one at web.dhan.co and run `npm run set-token`.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { DhanClient } from './dhan.ts';

export interface TokenStatus {
  ok: boolean;
  /** Epoch ms, when Dhan reports it. */
  validUntil: number | null;
  lastCheck: number | null;
  lastRenewal: number | null;
  message: string;
}

const CHECK_EVERY_MS = 30 * 60_000;
const RENEW_BEFORE_MS = 2 * 3600_000;
const FALLBACK_RENEW_MS = 20 * 3600_000;

/** Dhan reports validity like "30/03/2025 15:37" (IST). */
export function parseTokenValidity(v: unknown): number | null {
  const s = String(v ?? '');
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})/.exec(s);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]) - 5.5 * 3600_000;
  const iso = Date.parse(s);
  return Number.isFinite(iso) ? iso : null;
}

/** RenewToken's response shape isn't documented in the SDK — accept the likely spellings. */
export function extractToken(json: any): string | null {
  const t = json?.accessToken ?? json?.access_token ?? json?.token ?? json?.data?.accessToken ?? json?.data?.token;
  return typeof t === 'string' && t.length > 20 ? t : null;
}

/** Replace (or append) KEY=value in an env file, atomically, keeping permissions tight. */
export function writeEnvValue(path: string, key: string, value: string) {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  let found = false;
  const next = lines.map((l) => {
    if (new RegExp(`^\\s*${key}\\s*=`).test(l)) {
      found = true;
      return `${key}=${value}`;
    }
    return l;
  });
  if (!found) next.push(`${key}=${value}`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, next.join('\n'), { mode: 0o600 });
  renameSync(tmp, path);
}

export class TokenKeeper {
  status: TokenStatus = { ok: false, validUntil: null, lastCheck: null, lastRenewal: null, message: 'Not checked yet' };
  private dhan: DhanClient;
  private envPath: string | null;
  private autoRenew: boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = Date.now();
  private now: () => number;

  constructor(dhan: DhanClient, opts: { envPath: string | null; autoRenew: boolean; now?: () => number }) {
    this.dhan = dhan;
    this.envPath = opts.envPath;
    this.autoRenew = opts.autoRenew;
    this.now = opts.now ?? Date.now;
  }

  async check(): Promise<TokenStatus> {
    try {
      const p = await this.dhan.profile();
      const validUntil = parseTokenValidity(p?.tokenValidity);
      this.status = {
        ...this.status,
        ok: true,
        validUntil,
        lastCheck: this.now(),
        message: validUntil ? `Token valid until ${new Date(validUntil).toISOString()}` : 'Token valid',
      };
    } catch (e) {
      this.status = { ...this.status, ok: false, lastCheck: this.now(), message: (e as Error).message };
    }
    return this.status;
  }

  private dueForRenewal(): boolean {
    const now = this.now();
    if (this.status.validUntil) return this.status.validUntil - now < RENEW_BEFORE_MS && this.status.validUntil > now;
    const since = this.status.lastRenewal ?? this.startedAt;
    return now - since > FALLBACK_RENEW_MS;
  }

  async renew(): Promise<boolean> {
    try {
      const token = extractToken(await this.dhan.renewToken());
      if (!token) throw new Error('RenewToken response had no token');
      this.dhan.setAccessToken(token);
      if (this.envPath) writeEnvValue(this.envPath, 'DHAN_ACCESS_TOKEN', token);
      this.status = { ...this.status, lastRenewal: this.now() };
      await this.check();
      console.log(`[token] renewed. ${this.status.message}`);
      return true;
    } catch (e) {
      console.warn(`[token] renewal failed: ${(e as Error).message}`);
      return false;
    }
  }

  async tick() {
    await this.check();
    if (this.autoRenew && this.status.ok && this.dueForRenewal()) await this.renew();
  }

  start() {
    void this.tick().then(() =>
      console.log(`[token] ${this.status.ok ? 'Dhan connection OK' : 'Dhan check FAILED'}: ${this.status.message}`),
    );
    this.timer = setInterval(() => void this.tick(), CHECK_EVERY_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
