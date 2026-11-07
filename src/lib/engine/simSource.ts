/**
 * Demo data source: an accelerated NIFTY simulation for trying the engine
 * without a Dhan account. Every refresh advances the market by one 5-minute
 * candle and rebuilds a full option chain (Black-Scholes prices + Greeks,
 * synthetic OI). Simulated clock, so daily limits roll over in demo days.
 */
import { greeks, smileIV } from '../blackScholes.ts';
import { mulberry32 } from '../simulator.ts';
import { istToEpoch, yearsToExpiry, nextWeeklyExpiry } from '../time.ts';
import type { EngineDataSource } from './runner.ts';
import { catalogEntry } from './catalog.ts';
import type { Candle, ChainSnapshot, ChainStrike, EngineConfig } from './types.ts';

const FIVE_MIN = 5 * 60_000;
const BARS_PER_DAY = 75; // 09:15 → 15:30

function nextSessionStart(t: number): number {
  // Next trading day 09:15 IST after the candle at t.
  let d = new Date(t + 5.5 * 3600_000);
  do {
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return istToEpoch(d.toISOString().slice(0, 10), 9, 15);
}

/** One simulated instrument (its own random market and clock). */
class SymbolSim {
  private rand: () => number = mulberry32(1);
  private candles: Candle[] = [];
  private drift = 0;
  private barInDay = 0;
  private nextT = 0;
  private anchor = 24200;
  /** Price scale vs NIFTY, so every instrument gets proportional moves. */
  private scale = 1;
  private oi = 0;
  private symbol = '';
  private tick = 0.05;
  private seed: number;
  private startDay: string;

  constructor(seed: number, startDay: string, symbol: string, price: number, tick: number) {
    this.seed = seed;
    this.startDay = startDay;
    this.tick = tick;
    this.reseed(symbol, price);
  }

  /** Bring a newly opened instrument up to the other instruments' clock. */
  catchUp(t: number) {
    for (let i = 0; i < BARS_PER_DAY * 60 && this.now() < t; i++) {
      const last = this.candles[this.candles.length - 1];
      this.candles.push(this.makeCandle(this.nextT, last.c));
      this.nextT = this.advance(this.nextT);
      if (this.candles.length > BARS_PER_DAY * 4) this.candles = this.candles.slice(-BARS_PER_DAY * 4);
    }
  }

  /** (Re)build three sessions of history at this instrument's price level. */
  private reseed(symbol: string, price: number) {
    this.symbol = symbol;
    this.rand = mulberry32(this.seed);
    this.candles = [];
    this.drift = 0;
    this.barInDay = 0;
    this.anchor = price;
    this.scale = price / 24200;
    this.oi = 50_000;
    let t = istToEpoch(this.startDay, 9, 15);
    for (let i = 0; i < BARS_PER_DAY * 3; i++) {
      const c = this.makeCandle(t, price);
      this.candles.push(c);
      price = c.c;
      t = this.advance(t);
    }
    this.nextT = t;
  }

  private advance(t: number) {
    this.barInDay++;
    if (this.barInDay >= BARS_PER_DAY) {
      this.barInDay = 0;
      return nextSessionStart(t);
    }
    return t + FIVE_MIN;
  }

  private gauss() {
    const u = Math.max(this.rand(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.rand());
  }

  private makeCandle(t: number, prevClose: number): Candle {
    // Regime-switching drift so trends (and therefore signals) actually occur.
    if (this.rand() < 0.05) this.drift = (this.rand() - 0.5) * 0.0008;
    // Gentle pull back toward the anchor keeps a week of demo inside a realistic band.
    const revert = ((this.anchor - prevClose) / this.anchor) * 0.01;
    const k = this.scale;
    const o = prevClose + this.gauss() * 1.5 * k;
    const c = o * (1 + this.drift + revert + this.gauss() * 0.00035);
    const h = Math.max(o, c) + Math.abs(this.gauss()) * 3 * k;
    const l = Math.min(o, c) - Math.abs(this.gauss()) * 3 * k;
    const v = Math.round(1_500_000 * (0.6 + this.rand()) * (1 + Math.abs(c - o) / (15 * k)));
    // Open interest builds with trends and unwinds in chop (gives the futures OI factor something to read).
    this.oi = Math.max(
      1000,
      Math.round(this.oi * (1 + Math.abs(this.drift) * 40 - 0.004 + (this.rand() - 0.5) * 0.01)),
    );
    // Prices on the instrument's tick (₹1 for Gold Mini, 0.05 for NIFTY / Lead Mini).
    const r2 = (x: number) => Number((Math.round(x / this.tick) * this.tick).toFixed(4));
    return { t, o: r2(o), h: r2(h), l: r2(l), c: r2(c), v, oi: this.oi };
  }

  now() {
    return this.candles[this.candles.length - 1].t + FIVE_MIN - 1000;
  }

  private chain(spot: number, now: number, cfg: EngineConfig): ChainSnapshot {
    const expiry = nextWeeklyExpiry(now);
    const t = yearsToExpiry(expiry, now);
    const step = cfg.strikeInterval;
    const atm = Math.round(spot / step) * step;
    const trend = this.drift; // writers lean against the move
    const strikes: ChainStrike[] = [];
    for (let k = atm - 30 * step; k <= atm + 30 * step; k += step) {
      const dist = (k - spot) / (step * 6);
      const iv = smileIV(spot, k, 0.11);
      const mk = (type: 'CE' | 'PE') => {
        const g = greeks({ spot, strike: k, t, iv, type });
        const side = type === 'CE' ? Math.max(0, dist) : Math.max(0, -dist);
        const lean = type === 'CE' ? 1 - trend * 400 : 1 + trend * 400;
        const oi = Math.round(
          4_000_000 * Math.exp(-((side - 0.6) ** 2)) * Math.max(0.2, lean) * (0.8 + this.rand() * 0.4),
        );
        return {
          ltp: Math.max(0.05, Math.round(g.price * 20) / 20),
          oi,
          prevOi: Math.round(oi * (0.85 + this.rand() * 0.2)),
          volume: Math.round(oi * (0.5 + this.rand())),
          iv: iv * 100,
          delta: g.delta,
          gamma: g.gamma,
          theta: g.theta,
          vega: g.vega,
        };
      };
      strikes.push({ strike: k, ce: mk('CE'), pe: mk('PE') });
    }
    return { spot, expiry, strikes };
  }

  async load(cfg: EngineConfig) {
    if (cfg.instrumentKind === 'MCX_FUTURES') {
      const last = this.candles[this.candles.length - 1];
      this.candles.push(this.makeCandle(this.nextT, last.c));
      this.nextT = this.advance(this.nextT);
      if (this.candles.length > BARS_PER_DAY * 4) this.candles = this.candles.slice(-BARS_PER_DAY * 4);
      const candles = this.candles.slice(-BARS_PER_DAY * 3);
      const spot = candles[candles.length - 1].c;
      const expiry = new Date(this.now() + 5.5 * 3600_000 + 20 * 86400_000).toISOString().slice(0, 10);
      return {
        candles,
        chain: { spot, expiry, strikes: [] },
        contract: { securityId: '0', expiry, tradingSymbol: `${cfg.symbol} (demo)` },
      };
    }
    const last = this.candles[this.candles.length - 1];
    this.candles.push(this.makeCandle(this.nextT, last.c));
    this.nextT = this.advance(this.nextT);
    if (this.candles.length > BARS_PER_DAY * 4) this.candles = this.candles.slice(-BARS_PER_DAY * 4);
    const candles = this.candles.slice(-BARS_PER_DAY * 3);
    const spot = candles[candles.length - 1].c;
    return { candles, chain: this.chain(spot, this.now(), cfg) };
  }
}

/**
 * Demo data source: one simulated market per instrument (so several indexes can be watched at
 * once), all on one shared clock. Every load of an instrument advances it by one 5-min candle.
 */
export class SimEngineSource implements EngineDataSource {
  alwaysOpen = true;
  private sims = new Map<string, SymbolSim>();
  private seed: number;
  private startDay: string;
  private lastNow = 0;

  constructor(seed = 7, startDay = '2026-08-24') {
    this.seed = seed;
    this.startDay = startDay;
  }

  private sim(cfg: EngineConfig): SymbolSim {
    let sim = this.sims.get(cfg.symbol);
    if (!sim) {
      const tick = cfg.instrumentKind === 'MCX_FUTURES' ? cfg.tickSize || 0.05 : 0.05;
      // A different but repeatable market per instrument (NIFTY keeps the original seed).
      const salt = cfg.symbol === 'NIFTY' ? 0 : [...cfg.symbol].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 9973, 0);
      sim = new SymbolSim(this.seed + salt, this.startDay, cfg.symbol, catalogEntry(cfg.symbol)?.demoPrice ?? 24200, tick);
      if (this.lastNow) sim.catchUp(this.lastNow - FIVE_MIN);
      this.sims.set(cfg.symbol, sim);
    }
    return sim;
  }

  now() {
    return this.lastNow || this.sim({ symbol: 'NIFTY', instrumentKind: 'INDEX_OPTIONS' } as EngineConfig).now();
  }

  async load(cfg: EngineConfig) {
    const sim = this.sim(cfg);
    const out = await sim.load(cfg);
    this.lastNow = Math.max(this.lastNow, sim.now());
    return out;
  }
}

