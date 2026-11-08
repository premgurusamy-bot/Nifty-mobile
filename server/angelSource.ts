/**
 * Angel One market data for the engine (index options; PAPER first — orders stay on Dhan):
 *  - 5-min index candles (getCandleData);
 *  - an option chain built from Angel's pieces: the contract search gives the expiries and each
 *    strike's token, one or two FULL quote calls give LTP / OI / volume for ATM ± 20 strikes (and the
 *    index price), and optionGreek gives IV + Greeks per strike;
 *  - the chain carries Angel's tokens, so the 1-second ticks quote BANK NIFTY through Angel too.
 * Angel's quote has no previous-day OI: "change in OI" (display only) counts from the first quote
 * the app saw today.
 */
import type { EngineDataSource } from '../src/lib/engine/runner.ts';
import type { ChainSnapshot, ChainStrike, EngineConfig, Leg } from '../src/lib/engine/types.ts';
import type { QuoteMap, QuoteSource } from '../src/lib/engine/ticks.ts';
import { istDateString, toIST } from '../src/lib/time.ts';
import { AngelError, type AngelClient } from './angel.ts';

/** Angel's index tokens (exchange NSE). */
export const ANGEL_INDEX_TOKENS: Record<string, string> = { NIFTY: '99926000', BANKNIFTY: '99926009', FINNIFTY: '99926037' };
export const ANGEL_SEG = { index: 'ANGEL:NSE', option: 'ANGEL:NFO' } as const;
const WINDOW = 20; // strikes each side of the money
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (ms: number) => {
  const d = toIST(ms);
  return `${istDateString(ms)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export interface AngelContract {
  token: string;
  tradingsymbol: string;
  /** ISO date, e.g. 2026-11-25. */
  expiry: string;
  strike: number;
  type: 'CE' | 'PE';
}

/** BANKNIFTY25NOV2654000CE → { expiry 2026-11-25, strike 54000, CE }. */
export function parseOptionSymbol(name: string, tradingsymbol: string): Omit<AngelContract, 'token' | 'tradingsymbol'> | null {
  const m = new RegExp(`^${name}(\\d{2})([A-Z]{3})(\\d{2})(\\d+(?:\\.\\d+)?)(CE|PE)$`).exec(String(tradingsymbol).toUpperCase());
  if (!m) return null;
  const mon = MONTHS.indexOf(m[2]);
  if (mon < 0) return null;
  return { expiry: `20${m[3]}-${pad(mon + 1)}-${m[1]}`, strike: Number(m[4]), type: m[5] as 'CE' | 'PE' };
}

/** 2026-11-25 → 25NOV2026 (optionGreek) / 25NOV26 (trading symbols). */
export const angelExpiry = (iso: string, long = true) => {
  const [y, mo, d] = iso.split('-');
  return `${d}${MONTHS[Number(mo) - 1]}${long ? y : y.slice(2)}`;
};

export function mapAngelCandles(rows: any[]) {
  return (rows ?? [])
    .map((r) => ({ t: Date.parse(String(r[0])), o: num(r[1]), h: num(r[2]), l: num(r[3]), c: num(r[4]), v: num(r[5]) }))
    .filter((c) => Number.isFinite(c.t) && c.c > 0);
}

export class AngelEngineSource implements EngineDataSource {
  private angel: AngelClient;
  private contracts = new Map<string, { day: string; list: AngelContract[] }>();
  private greeks = new Map<string, { at: number; rows: any[] }>();
  /** First OI seen today per token (Angel's quote has no previous-day OI). */
  private oiBase = new Map<string, { day: string; oi: number }>();

  constructor(angel: AngelClient) {
    this.angel = angel;
  }

  /** Every option contract of the index (cached for the day): expiries + strike tokens. */
  private async contractsOf(name: string, now: number): Promise<AngelContract[]> {
    const day = istDateString(now);
    const hit = this.contracts.get(name);
    if (hit && hit.day === day) return hit.list;
    const parse = (rows: any[]) =>
      rows
        .map((r) => {
          const p = parseOptionSymbol(name, r.tradingsymbol);
          return p && r.symboltoken ? { ...p, token: String(r.symboltoken), tradingsymbol: String(r.tradingsymbol).toUpperCase() } : null;
        })
        .filter((x): x is AngelContract => !!x);
    let list = parse(await this.angel.searchScrip('NFO', name));
    const expiries = [...new Set(list.map((c) => c.expiry))].filter((e) => e >= day).sort();
    // The search may cut long lists short: fetch the nearest expiry's strikes on their own.
    if (expiries[0]) {
      const near = parse(await this.angel.searchScrip('NFO', `${name}${angelExpiry(expiries[0], false)}`));
      const seen = new Set(list.map((c) => c.token));
      list = [...list, ...near.filter((c) => !seen.has(c.token))];
    }
    if (!list.length) throw new AngelError(`Angel One returned no ${name} option contracts`);
    this.contracts.set(name, { day, list });
    return list;
  }

  /** The Angel contract of one option (for orders): searched if not cached yet. */
  async contractFor(name: string, expiry: string, strike: number, type: 'CE' | 'PE', now = Date.now()): Promise<AngelContract> {
    const c = (await this.contractsOf(name, now)).find((x) => x.expiry === expiry && x.strike === strike && x.type === type);
    if (!c) throw new AngelError(`No Angel One contract for ${name} ${expiry} ${strike} ${type}`, 'NO_CONTRACT');
    return c;
  }

  async load(cfg: EngineConfig, now: number) {
    const name = cfg.symbol;
    const indexToken = ANGEL_INDEX_TOKENS[name];
    if (!indexToken) throw new AngelError(`Angel One data isn't set up for ${name}`);
    const day = istDateString(now);
    const all = await this.contractsOf(name, now);
    const expiries = [...new Set(all.map((c) => c.expiry))].filter((e) => e >= day).sort();
    const expiry = cfg.expiry && expiries.includes(cfg.expiry) ? cfg.expiry : expiries[0];
    if (!expiry) throw new AngelError(`No upcoming ${name} expiry at Angel One`);

    const candles = mapAngelCandles(
      await this.angel.candles({
        exchange: 'NSE',
        symboltoken: indexToken,
        interval: 'FIVE_MINUTE',
        fromdate: stamp(now - 4 * 86400_000),
        todate: stamp(now),
      }),
    );
    if (!candles.length) throw new AngelError(`Angel One returned no ${name} candles`);
    let spot = candles[candles.length - 1].c;

    // The strikes around the money, both sides.
    const ofExpiry = all.filter((c) => c.expiry === expiry);
    const strikes = [...new Set(ofExpiry.map((c) => c.strike))].sort((a, b) => a - b);
    const atmIdx = strikes.reduce((bi, s, i) => (Math.abs(s - spot) < Math.abs(strikes[bi] - spot) ? i : bi), 0);
    const near = new Set(strikes.slice(Math.max(0, atmIdx - WINDOW), atmIdx + WINDOW + 1));
    const legs = ofExpiry.filter((c) => near.has(c.strike));

    // FULL quotes: the index + options, 50 tokens per call.
    const tokens = [indexToken, ...legs.map((l) => l.token)];
    const quotes = new Map<string, any>();
    for (let i = 0; i < tokens.length; i += 50) {
      const batch = tokens.slice(i, i + 50);
      const ex: Record<string, string[]> = {};
      for (const t of batch) (ex[t === indexToken ? 'NSE' : 'NFO'] ??= []).push(t);
      for (const q of await this.angel.quote('FULL', ex)) quotes.set(String(q.symbolToken ?? q.symboltoken), q);
    }
    const idx = num(quotes.get(indexToken)?.ltp);
    if (idx > 0) spot = idx;

    // IV + Greeks (refreshed at most every 15 s; the chain's prices come from the quotes above).
    const gk = `${name}|${expiry}`;
    let g = this.greeks.get(gk);
    if (!g || now - g.at > 15_000 || now < g.at) {
      try {
        g = { at: now, rows: await this.angel.optionGreeks(name, angelExpiry(expiry)) };
        this.greeks.set(gk, g);
      } catch {
        /* keep the last Greeks (or none): prices and OI still work */
      }
    }
    const greekOf = new Map<string, any>();
    for (const r of g?.rows ?? []) greekOf.set(`${num(r.strikePrice)}|${String(r.optionType).toUpperCase()}`, r);

    const leg = (c: AngelContract | undefined): Leg | null => {
      if (!c) return null;
      const q = quotes.get(c.token);
      if (!q) return null;
      const oi = num(q.opnInterest);
      const b = this.oiBase.get(c.token);
      if (!b || b.day !== day) this.oiBase.set(c.token, { day, oi });
      const gr = greekOf.get(`${c.strike}|${c.type}`) ?? {};
      return {
        ltp: num(q.ltp),
        oi,
        prevOi: b && b.day === day ? b.oi : oi,
        volume: num(q.tradeVolume),
        iv: num(gr.impliedVolatility),
        delta: num(gr.delta),
        gamma: num(gr.gamma),
        theta: num(gr.theta),
        vega: num(gr.vega),
        securityId: c.token,
      };
    };
    const rows: ChainStrike[] = [...near]
      .sort((a, b) => a - b)
      .map((strike) => ({
        strike,
        ce: leg(legs.find((l) => l.strike === strike && l.type === 'CE')),
        pe: leg(legs.find((l) => l.strike === strike && l.type === 'PE')),
      }))
      .filter((r) => r.ce || r.pe);
    if (!rows.length) throw new AngelError(`Angel One returned no ${name} option quotes for ${expiry}`);
    const chain: ChainSnapshot = {
      spot,
      expiry,
      strikes: rows,
      feed: 'ANGEL',
      quoteSpot: { segment: ANGEL_SEG.index, securityId: indexToken },
      legSegment: ANGEL_SEG.option,
    };
    return { candles, chain };
  }
}

/** Fast-tick quotes for Angel-fed instruments (segments 'ANGEL:NSE' / 'ANGEL:NFO'): one LTP call. */
export function angelQuoteSource(angel: AngelClient): QuoteSource {
  return async (reqs) => {
    const ex: Record<string, string[]> = {};
    for (const r of reqs) {
      const e = r.segment.replace(/^ANGEL:/, '');
      const list = (ex[e] ??= []);
      if (!list.includes(r.securityId)) list.push(r.securityId);
    }
    const out: QuoteMap = {};
    for (const q of await angel.quote('LTP', ex)) {
      const ltp = num(q.ltp);
      if (ltp > 0) out[`ANGEL:${q.exchange}|${q.symbolToken ?? q.symboltoken}`] = ltp;
    }
    return out;
  };
}
