import type { OptionType } from './instruments.ts';

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, |err| < 7.5e-8). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

export interface BSInput {
  spot: number;
  strike: number;
  /** Years to expiry. */
  t: number;
  /** Annualised volatility, e.g. 0.12 for 12%. */
  iv: number;
  /** Risk-free rate. */
  r?: number;
  type: OptionType;
}

export interface BSResult {
  price: number;
  delta: number;
}

export const RISK_FREE_RATE = 0.065;

export function blackScholes({ spot, strike, t, iv, r = RISK_FREE_RATE, type }: BSInput): BSResult {
  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(spot / strike) + (r + (iv * iv) / 2) * t) / (iv * sqrtT);
  const d2 = d1 - iv * sqrtT;
  const disc = Math.exp(-r * t);
  if (type === 'CE') {
    return { price: spot * normCdf(d1) - strike * disc * normCdf(d2), delta: normCdf(d1) };
  }
  return { price: strike * disc * normCdf(-d2) - spot * normCdf(-d1), delta: normCdf(d1) - 1 };
}

/** Simple volatility smile with a put skew, used to make the simulated chain look plausible. */
export function smileIV(spot: number, strike: number, baseIV = 0.12): number {
  const m = Math.log(strike / spot);
  return Math.max(0.05, baseIV - 0.15 * m + 2.5 * m * m);
}

/** Exchange tick size for NIFTY options. */
export const roundToTick = (p: number, tick = 0.05) => Math.max(tick, Math.round(p / tick) * tick);
