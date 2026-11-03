/** IST helpers. India has no DST, so a fixed +05:30 offset is correct. */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** A Date whose UTC getters return IST wall-clock values. */
export const toIST = (ms: number) => new Date(ms + IST_OFFSET_MS);

const pad = (n: number) => String(n).padStart(2, '0');

export const istDateString = (ms: number) => {
  const d = toIST(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/** Epoch ms for a given IST date (YYYY-MM-DD) and time. */
export function istToEpoch(date: string, hh: number, mm: number): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - IST_OFFSET_MS;
}

export type MarketStatus = 'PRE_OPEN' | 'OPEN' | 'CLOSED';

/**
 * NSE equity session: pre-open 09:00–09:15, normal 09:15–15:30 IST, Mon–Fri.
 * Exchange holidays are not modelled.
 */
export function marketStatus(ms: number): MarketStatus {
  const d = toIST(ms);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return 'CLOSED';
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (mins >= 9 * 60 && mins < 9 * 60 + 15) return 'PRE_OPEN';
  if (mins >= 9 * 60 + 15 && mins < 15 * 60 + 30) return 'OPEN';
  return 'CLOSED';
}

/**
 * Next NIFTY weekly expiry (Tuesday, per NSE's schedule since Sep 2025).
 * If today is Tuesday and the market has closed, rolls to next week.
 * Holiday shifts are not modelled.
 */
export function nextWeeklyExpiry(ms: number, weekday = 2): string {
  const d = toIST(ms);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  let add = (weekday - d.getUTCDay() + 7) % 7;
  if (add === 0 && mins >= 15 * 60 + 30) add = 7;
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + add));
  return `${target.getUTCFullYear()}-${pad(target.getUTCMonth() + 1)}-${pad(target.getUTCDate())}`;
}

/** Following N weekly expiries starting from the next one. */
export function upcomingExpiries(ms: number, count: number): string[] {
  const out: string[] = [];
  let cursor = ms;
  for (let i = 0; i < count; i++) {
    const e = nextWeeklyExpiry(cursor);
    out.push(e);
    cursor = istToEpoch(e, 16, 0); // after close on expiry day → next week
  }
  return out;
}

/** Years until 15:30 IST on the expiry date (floored at ~5 minutes). */
export function yearsToExpiry(expiry: string, ms: number): number {
  const t = istToEpoch(expiry, 15, 30) - ms;
  return Math.max(t, 5 * 60 * 1000) / (365 * 24 * 60 * 60 * 1000);
}
