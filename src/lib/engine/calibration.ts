/**
 * Scoring calibration: the confidence engine was tuned on NIFTY (the Excel workbook). A few of
 * its thresholds are absolute numbers that only make sense at NIFTY's price level, volatility and
 * lot size. Calibration rescales just those, so the same factors and weights mean the same thing
 * on BANK NIFTY, FIN NIFTY and the MCX minis — and NIFTY itself stays exactly as it was.
 *
 *  - price scale  (spot ÷ NIFTY reference): gamma band ÷ scale, theta limits × scale
 *    (ATM gamma ∝ 1/S, theta in premium points ∝ S).
 *  - volatility scale (5-min ATR % ÷ NIFTY reference ATR %): VWAP-distance and day-open-move
 *    thresholds (in %) × scale, so "clearly above VWAP" means the same number of typical moves.
 *  - lot scale (lot size ÷ NIFTY lot): the OI / volume units used to rank strikes by liquidity.
 */
import type { EngineConfig } from './types.ts';

/** NIFTY reference levels the original thresholds were set on (workbook data, Aug 2026). */
export const NIFTY_REF = { spot: 24200, atrPct: 0.055, lotSize: 65 };

export interface Calibration {
  /** True for NIFTY: every factor is 1 and the workbook scoring is untouched. */
  base: boolean;
  price: number;
  vol: number;
  lot: number;
}

export const NO_CALIBRATION: Calibration = { base: true, price: 1, vol: 1, lot: 1 };

const clamp = (n: number, a: number, b: number) => (Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : 1);

/** Calibration for the instrument being scored, from its live spot and 5-minute ATR. */
export function calibrationFor(cfg: Pick<EngineConfig, 'symbol' | 'lotSize'>, spot: number, atr: number): Calibration {
  if (cfg.symbol === 'NIFTY') return NO_CALIBRATION;
  const atrPct = spot > 0 && atr > 0 ? (atr / spot) * 100 : NIFTY_REF.atrPct;
  return {
    base: false,
    price: clamp(spot / NIFTY_REF.spot, 0.0001, 10_000),
    // Bounded so one wild or frozen candle can't make a threshold absurd.
    vol: clamp(atrPct / NIFTY_REF.atrPct, 0.5, 4),
    lot: clamp((cfg.lotSize || NIFTY_REF.lotSize) / NIFTY_REF.lotSize, 0.01, 100),
  };
}
