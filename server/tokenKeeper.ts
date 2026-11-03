/**
 * Keeps the Dhan access token alive.
 *
 * - On start: GET /v2/profile to confirm the token works and read its validity.
 * - Renews (GET /v2/RenewToken) ~2 h before expiry, or every 20 h when the
 *   expiry can't be read, then hands the new token to `persist` (the server
 *   writes it to server/.env; the app saves it in the phone's secure storage).
 *
 * No Node-only imports: this file runs on the server and inside the app.
 *
 * Renewal only extends a token that is still valid. If the token has already
 * expired, generate a new one at web.dhan.co and run `npm run set-token`.
 */
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

export class TokenKeeper {
  status: TokenStatus = { ok: false, validUntil: null, lastCheck: null, lastRenewal: null, message: 'Not checked yet' };
  private dhan: DhanClient;
  private persist: ((token: string) => void | Promise<void>) | null;
  private autoRenew: boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = Date.now();
  private now: () => number;

  constructor(
    dhan: DhanClient,
    opts: { persist?: (token: string) => void | Promise<void>; autoRenew: boolean; now?: () => number },
  ) {
    this.dhan = dhan;
    this.persist = opts.persist ?? null;
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
      if (this.persist) await this.persist(token);
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
