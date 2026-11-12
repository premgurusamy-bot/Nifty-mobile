/**
 * Market Memory — records every closed 5-minute candle of each watched index with what the app saw
 * at that moment: price (OHLC), candle indicators (EMA, VWAP, RSI, ADX/DI, ATR), the option chain
 * (spot, PCR, ATM IV, premiums of the strikes around the money) and the scoring engine's view (score
 * CE / PE, the 10 factor points for each side, direction, confidence). Tops / bottoms and the
 * indicator scorecard are worked out from these records (analysis.ts) — for reference, and as
 * training data for a machine-learning engine later.
 *
 * Only live candles the app actually saw are recorded (no back-fill: the chain view of a past
 * candle isn't known). Storage is injected (one file per day on the phone); nothing here changes
 * trading. Pure apart from the store.
 */
import type { Candle, ChainSnapshot, Dashboard, ScoreBreakdown } from '../engine/types.ts';
import { indicatorSeries, type CandleIndicators } from './indicators.ts';

/** The scoring engine's factors, in a fixed order (records keep the points as arrays). */
export const FACTORS: (keyof ScoreBreakdown)[] = [
  'emaTrend',
  'vwapPosition',
  'priceAction',
  'oiBias',
  'pcr',
  'deltaFit',
  'ivLevel',
  'gamma',
  'thetaDrag',
  'volume',
];

export interface CandleRecord {
  /** Index symbol (NIFTY, BANKNIFTY, FINNIFTY …). */
  s: string;
  /** Candle start (ms, 5-minute candle). */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  ind: CandleIndicators;
  spot: number;
  pcr: number;
  /** IV of the engine's selected option, and the IV percentile (null = not enough history). */
  iv: number;
  ivp: number | null;
  /** Engine: leading direction, its score, both scores, and the factor points per side (FACTORS order). */
  dir: string;
  conf: number;
  sCE: number;
  sPE: number;
  fCE: number[] | null;
  fPE: number[] | null;
  /** At-the-money strike and premiums [CE, PE] of the strikes around it (ATM ± 3). */
  atm: number;
  prem: Record<string, [number, number]>;
  /** Lot size (₹ per point per lot for option premiums). */
  lot: number;
}

export interface DayFile {
  v: 1;
  day: string;
  records: CandleRecord[];
}

export interface MemoryStore {
  load(day: string): Promise<DayFile | null>;
  save(f: DayFile): Promise<void>;
  /** Recorded days, YYYY-MM-DD. */
  days(): Promise<string[]>;
  remove(day: string): Promise<void>;
}

type Snapshot = Omit<CandleRecord, 's' | 't' | 'o' | 'h' | 'l' | 'c' | 'ind'>;

export const istDay = (t: number) => new Date(t + 5.5 * 3600_000).toISOString().slice(0, 10);
const r2 = (n: number) => Math.round(n * 100) / 100;
const vec = (b: ScoreBreakdown | undefined) => (b ? FACTORS.map((k) => r2(Number(b[k]) || 0)) : null);

/** What the app sees now for an index (kept until its candle closes). */
export function snapshotOf(chain: ChainSnapshot, dash: Dashboard, lot: number): Snapshot {
  const d = dash.decision;
  const br = (dash as Dashboard & { breakdowns?: { CE: ScoreBreakdown; PE: ScoreBreakdown } }).breakdowns;
  const prem: Record<string, [number, number]> = {};
  let atm = dash.market.atm || 0;
  if (chain.strikes.length) {
    const spot = chain.spot || dash.market.spot;
    let i = 0;
    for (let k = 1; k < chain.strikes.length; k++)
      if (Math.abs(chain.strikes[k].strike - spot) < Math.abs(chain.strikes[i].strike - spot)) i = k;
    atm = chain.strikes[i].strike;
    for (const row of chain.strikes.slice(Math.max(0, i - 3), i + 4))
      prem[String(row.strike)] = [r2(row.ce?.ltp ?? 0), r2(row.pe?.ltp ?? 0)];
  }
  return {
    spot: r2(chain.spot || dash.market.spot),
    pcr: r2(dash.chain.pcr),
    iv: r2(dash.greeks.iv),
    ivp: d.ivPercentile != null && d.ivPercentile >= 0 ? r2(d.ivPercentile) : null,
    dir: d.direction,
    conf: r2(d.confidence),
    sCE: r2(d.scoreCE ?? 0),
    sPE: r2(d.scorePE ?? 0),
    fCE: vec(br?.CE),
    fPE: vec(br?.PE),
    atm,
    prem,
    lot,
  };
}

export class MarketMemory {
  /** Recording on / off (Market Memory screen). */
  enabled = true;
  /** Days kept on the phone. */
  keepDays = 60;
  /** Last storage problem ('' = fine) and candles recorded since the app started. */
  lastError = '';
  recorded = 0;
  private store: MemoryStore;
  private forming = new Map<string, { t: number; snap: Snapshot }>();
  private cache = new Map<string, DayFile>();
  private q: Promise<void> = Promise.resolve();
  private pruned = '';

  constructor(store: MemoryStore) {
    this.store = store;
  }

  /**
   * Called after every engine cycle for an index. When a new candle has started, the one before it
   * is closed: it is recorded with the last view the app had during it.
   */
  observe(symbol: string, candles: Candle[], chain: ChainSnapshot | null, dash: Dashboard | null, lot: number) {
    if (!this.enabled || !chain || !dash || !chain.strikes.length || !candles.length) return;
    // Recording must never disturb trading: any problem here is only noted.
    try {
      const last = candles[candles.length - 1];
      const f = this.forming.get(symbol);
      if (f && last.t > f.t) {
        const idx = candles.findIndex((x) => x.t === f.t);
        if (idx >= 0) this.record(symbol, candles.slice(0, idx + 1), f.snap);
      }
      this.forming.set(symbol, { t: last.t, snap: snapshotOf(chain, dash, lot) });
    } catch (e) {
      this.lastError = (e as Error).message;
    }
  }

  private record(symbol: string, closed: Candle[], snap: Snapshot) {
    const c = closed[closed.length - 1];
    const ind = indicatorSeries(closed).at(-1)!;
    const rec: CandleRecord = {
      s: symbol,
      t: c.t,
      o: c.o,
      h: c.h,
      l: c.l,
      c: c.c,
      ind: Object.fromEntries(Object.entries(ind).map(([k, v]) => [k, r2(v)])) as unknown as CandleIndicators,
      ...snap,
    };
    const day = istDay(c.t);
    this.q = this.q.then(async () => {
      try {
        const f = await this.day(day);
        if (f.records.some((x) => x.s === rec.s && x.t === rec.t)) return;
        f.records.push(rec);
        await this.store.save(f);
        this.recorded++;
        this.lastError = '';
        if (this.pruned !== day) {
          this.pruned = day;
          const cutoff = istDay(c.t - this.keepDays * 86400_000);
          for (const d of await this.store.days()) if (d < cutoff) await this.store.remove(d);
        }
      } catch (e) {
        this.lastError = (e as Error).message;
      }
    });
  }

  private async day(day: string): Promise<DayFile> {
    let f = this.cache.get(day);
    if (!f) {
      f = (await this.store.load(day)) ?? { v: 1, day, records: [] };
      this.cache.clear(); // keep only the day being written
      this.cache.set(day, f);
    }
    return f;
  }

  /** Wait until pending saves are written. */
  flush(): Promise<void> {
    return this.q;
  }

  async days(): Promise<string[]> {
    await this.q;
    return (await this.store.days()).sort();
  }

  /** Records of the given days (oldest first). */
  async load(days: string[]): Promise<CandleRecord[]> {
    await this.q;
    const out: CandleRecord[] = [];
    for (const d of [...days].sort()) {
      const f = this.cache.get(d) ?? (await this.store.load(d).catch(() => null));
      if (f) out.push(...f.records);
    }
    return out;
  }

  /** Delete every recorded day. */
  async clear(): Promise<void> {
    await this.q;
    for (const d of await this.store.days()) await this.store.remove(d);
    this.cache.clear();
  }
}

/** In-memory store (tests, server). */
export function memoryStore(): MemoryStore & { files: Map<string, DayFile> } {
  const files = new Map<string, DayFile>();
  return {
    files,
    load: async (d) => (files.has(d) ? JSON.parse(JSON.stringify(files.get(d))) : null),
    save: async (f) => void files.set(f.day, JSON.parse(JSON.stringify(f))),
    days: async () => [...files.keys()],
    remove: async (d) => void files.delete(d),
  };
}
