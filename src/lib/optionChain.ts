import { blackScholes, roundToTick, smileIV } from './blackScholes.ts';
import { NIFTY_STRIKE_STEP, optionId, parseOptionId } from './instruments.ts';
import { yearsToExpiry } from './time.ts';

export interface ChainLeg {
  id: string;
  ltp: number;
  delta: number;
  iv: number;
  /** Open interest (live data only). */
  oi?: number;
}

export interface ChainRow {
  strike: number;
  ce: ChainLeg;
  pe: ChainLeg;
}

export const atmStrike = (spot: number, step = NIFTY_STRIKE_STEP) => Math.round(spot / step) * step;

export function priceOption(id: string, spot: number, now: number): number | null {
  const c = parseOptionId(id);
  if (!c) return null;
  const t = yearsToExpiry(c.expiry, now);
  const iv = smileIV(spot, c.strike);
  return roundToTick(blackScholes({ spot, strike: c.strike, t, iv, type: c.type }).price);
}

export function buildChain(spot: number, expiry: string, now: number, width = 10): ChainRow[] {
  const atm = atmStrike(spot);
  const t = yearsToExpiry(expiry, now);
  const rows: ChainRow[] = [];
  for (let i = -width; i <= width; i++) {
    const strike = atm + i * NIFTY_STRIKE_STEP;
    const iv = smileIV(spot, strike);
    const ce = blackScholes({ spot, strike, t, iv, type: 'CE' });
    const pe = blackScholes({ spot, strike, t, iv, type: 'PE' });
    rows.push({
      strike,
      ce: {
        id: optionId({ underlying: 'NIFTY', expiry, strike, type: 'CE' }),
        ltp: roundToTick(ce.price),
        delta: ce.delta,
        iv,
      },
      pe: {
        id: optionId({ underlying: 'NIFTY', expiry, strike, type: 'PE' }),
        ltp: roundToTick(pe.price),
        delta: pe.delta,
        iv,
      },
    });
  }
  return rows;
}
