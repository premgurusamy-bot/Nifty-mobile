/**
 * MCX futures contract resolution: which security id is "Gold Mini, current
 * month" today? Contracts roll monthly, so the id is looked up in Dhan's
 * instrument list (segment-wise endpoint first, the compact scrip master as a
 * fallback) and the nearest expiry at least `rollDays` away is chosen.
 *
 * Columns are found by header name; both Dhan's detailed and compact CSV
 * spellings are accepted. No Node-only imports (runs in the app).
 */
import type { FuturesContract } from '../src/lib/engine/runner.ts';
import { splitCsvLine } from './scripMaster.ts';

export const COMPACT_MASTER_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';

export interface FuturesRow {
  securityId: string;
  symbol: string;
  tradingSymbol: string;
  expiry: string;
  tickSize: number;
}

const COLS = {
  exch: ['EXCH_ID', 'SEM_EXM_EXCH_ID'],
  id: ['SECURITY_ID', 'SEM_SMST_SECURITY_ID'],
  instrument: ['INSTRUMENT', 'SEM_INSTRUMENT_NAME'],
  underlying: ['UNDERLYING_SYMBOL', 'SM_SYMBOL_NAME'],
  trading: ['SYMBOL_NAME', 'SEM_TRADING_SYMBOL', 'DISPLAY_NAME', 'SEM_CUSTOM_SYMBOL'],
  expiry: ['SM_EXPIRY_DATE', 'SEM_EXPIRY_DATE', 'EXPIRY_DATE'],
  tick: ['TICK_SIZE', 'SEM_TICK_SIZE'],
};

/** All MCX FUTCOM rows for `symbol` (e.g. GOLDM, CRUDEOILM, LEADMINI). */
export function parseMcxFutures(csv: string, symbol: string): FuturesRow[] {
  const lines = csv.split(/\r?\n/);
  const header = splitCsvLine(lines[0] ?? '').map((h) => h.trim().toUpperCase());
  const col = (names: string[]) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
  const ci = Object.fromEntries(Object.entries(COLS).map(([k, v]) => [k, col(v)])) as Record<keyof typeof COLS, number>;
  if (ci.id < 0 || ci.instrument < 0 || ci.expiry < 0) throw new Error('Unrecognised Dhan instrument list format');
  const sym = symbol.toUpperCase();
  const out: FuturesRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.includes('FUTCOM')) continue;
    const f = splitCsvLine(line);
    if (ci.exch >= 0 && f[ci.exch] !== 'MCX') continue;
    if (f[ci.instrument] !== 'FUTCOM') continue;
    const trading = ci.trading >= 0 ? f[ci.trading] : '';
    // Underlying: explicit column, else the trading symbol's prefix ("GOLDM-Dec2026-FUT").
    const und = (ci.underlying >= 0 && f[ci.underlying] ? f[ci.underlying] : trading.split(/[- ]/)[0]).toUpperCase();
    if (und !== sym) continue;
    const expiry = String(f[ci.expiry] ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) continue;
    const tick = ci.tick >= 0 ? Number(f[ci.tick]) : NaN;
    out.push({
      securityId: f[ci.id],
      symbol: sym,
      tradingSymbol: trading || `${sym} ${expiry}`,
      expiry,
      // Dhan's compact master lists ticks in paise for some segments; only trust sane values.
      tickSize: Number.isFinite(tick) && tick > 0 && tick < 1000 ? tick : 0,
    });
  }
  return out.sort((a, b) => a.expiry.localeCompare(b.expiry));
}

/** Nearest contract expiring at least `rollDays` from today (IST). */
export function pickCurrentContract(rows: FuturesRow[], now: number, rollDays: number): FuturesRow | null {
  const cutoff = new Date(now + 5.5 * 3600_000 + rollDays * 86400_000).toISOString().slice(0, 10);
  return rows.find((r) => r.expiry >= cutoff) ?? rows.at(-1) ?? null;
}

export interface ContractResolverOptions {
  /** Fetches Dhan's MCX instrument list (CSV text). */
  fetchSegmentCsv: () => Promise<string>;
  /** Fallback: the compact scrip master (large, all segments). */
  fetchCompactCsv?: () => Promise<string>;
}

/** Resolves and caches the current contract per symbol for the day. */
export class ContractResolver {
  private cache = new Map<string, { day: string; rows: FuturesRow[] }>();
  private o: ContractResolverOptions;
  constructor(o: ContractResolverOptions) {
    this.o = o;
  }

  async rows(symbol: string, now: number): Promise<FuturesRow[]> {
    const day = new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
    const hit = this.cache.get(symbol);
    if (hit && hit.day === day && hit.rows.length) return hit.rows;
    let rows: FuturesRow[] = [];
    let err: unknown = null;
    try {
      rows = parseMcxFutures(await this.o.fetchSegmentCsv(), symbol);
    } catch (e) {
      err = e;
    }
    if (!rows.length && this.o.fetchCompactCsv) {
      try {
        rows = parseMcxFutures(await this.o.fetchCompactCsv(), symbol);
      } catch (e) {
        err = e;
      }
    }
    if (!rows.length) {
      throw new Error(
        `Couldn't find ${symbol} futures in Dhan's instrument list${err ? ` (${(err as Error).message})` : ''} — enter the contract's security id in Settings`,
      );
    }
    this.cache.set(symbol, { day, rows });
    return rows;
  }

  async resolve(symbol: string, now: number, rollDays: number): Promise<FuturesContract> {
    const r = pickCurrentContract(await this.rows(symbol, now), now, rollDays);
    if (!r) throw new Error(`No ${symbol} futures contract found`);
    return { securityId: r.securityId, expiry: r.expiry, tradingSymbol: r.tradingSymbol, tickSize: r.tickSize || undefined };
  }
}
