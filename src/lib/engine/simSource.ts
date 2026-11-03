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

export class SimEngineSource implements EngineDataSource {
  alwaysOpen = true;
  private rand: () => number;
  private candles: Candle[] = [];
  private drift = 0;
  private barInDay = 0;
  private nextT = 0;
  private anchor = 24200;

  constructor(seed = 7, startDay = '2026-08-24') {
    this.rand = mulberry32(seed);
    let t = istToEpoch(startDay, 9, 15);
    let price = 24200;
    // Seed three sessions of history (enough for EMA50 + backtest).
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
    const o = prevClose + this.gauss() * 1.5;
    const c = o * (1 + this.drift + revert + this.gauss() * 0.00035);
    const h = Math.max(o, c) + Math.abs(this.gauss()) * 3;
    const l = Math.min(o, c) - Math.abs(this.gauss()) * 3;
    const v = Math.round(1_500_000 * (0.6 + this.rand()) * (1 + Math.abs(c - o) / 15));
    const r2 = (x: number) => Math.round(x * 20) / 20;
    return { t, o: r2(o), h: r2(h), l: r2(l), c: r2(c), v };
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
    const last = this.candles[this.candles.length - 1];
    this.candles.push(this.makeCandle(this.nextT, last.c));
    this.nextT = this.advance(this.nextT);
    if (this.candles.length > BARS_PER_DAY * 4) this.candles = this.candles.slice(-BARS_PER_DAY * 4);
    const candles = this.candles.slice(-BARS_PER_DAY * 3);
    const spot = candles[candles.length - 1].c;
    return { candles, chain: this.chain(spot, this.now(), cfg) };
  }
}
