/**
 * Instrument definitions and ID helpers.
 *
 * IDs:
 *   Index:   "NSE:NIFTY 50"
 *   Equity:  "NSE:RELIANCE"
 *   Option:  "NFO:NIFTY:2026-11-10:26000:CE"
 */

export type InstrumentKind = 'INDEX' | 'EQUITY' | 'OPTION';
export type OptionType = 'CE' | 'PE';

export interface EquityDef {
  symbol: string;
  name: string;
  /** Reference price used to seed the simulator (not live data). */
  basePrice: number;
  /** Sensitivity to the overall market move in the simulator. */
  beta: number;
}

export const NIFTY_ID = 'NSE:NIFTY 50';
export const NIFTY_BASE = 26000;

/**
 * NIFTY derivatives contract size. NSE revises lot sizes periodically —
 * verify against the latest NSE circular before relying on this.
 */
export const NIFTY_LOT_SIZE = 65;
export const NIFTY_STRIKE_STEP = 50;

/** Selection of NIFTY 50 constituents. Base prices are approximate seeds for simulation only. */
export const EQUITIES: EquityDef[] = [
  { symbol: 'RELIANCE', name: 'Reliance Industries', basePrice: 1480, beta: 1.0 },
  { symbol: 'HDFCBANK', name: 'HDFC Bank', basePrice: 1000, beta: 0.9 },
  { symbol: 'ICICIBANK', name: 'ICICI Bank', basePrice: 1400, beta: 1.1 },
  { symbol: 'INFY', name: 'Infosys', basePrice: 1550, beta: 0.8 },
  { symbol: 'TCS', name: 'Tata Consultancy Services', basePrice: 3100, beta: 0.7 },
  { symbol: 'BHARTIARTL', name: 'Bharti Airtel', basePrice: 2000, beta: 0.8 },
  { symbol: 'ITC', name: 'ITC', basePrice: 410, beta: 0.6 },
  { symbol: 'SBIN', name: 'State Bank of India', basePrice: 900, beta: 1.3 },
  { symbol: 'LT', name: 'Larsen & Toubro', basePrice: 3900, beta: 1.1 },
  { symbol: 'HINDUNILVR', name: 'Hindustan Unilever', basePrice: 2450, beta: 0.5 },
  { symbol: 'KOTAKBANK', name: 'Kotak Mahindra Bank', basePrice: 2100, beta: 1.0 },
  { symbol: 'AXISBANK', name: 'Axis Bank', basePrice: 1200, beta: 1.2 },
  { symbol: 'BAJFINANCE', name: 'Bajaj Finance', basePrice: 1000, beta: 1.4 },
  { symbol: 'MARUTI', name: 'Maruti Suzuki', basePrice: 16000, beta: 0.9 },
  { symbol: 'SUNPHARMA', name: 'Sun Pharmaceutical', basePrice: 1700, beta: 0.6 },
  { symbol: 'TITAN', name: 'Titan Company', basePrice: 3700, beta: 1.0 },
];

export const equityId = (symbol: string) => `NSE:${symbol}`;

export interface OptionContract {
  underlying: 'NIFTY';
  /** Expiry date, YYYY-MM-DD (IST). */
  expiry: string;
  strike: number;
  type: OptionType;
}

export const optionId = (c: OptionContract) => `NFO:${c.underlying}:${c.expiry}:${c.strike}:${c.type}`;

export function parseOptionId(id: string): OptionContract | null {
  const parts = id.split(':');
  if (parts.length !== 5 || parts[0] !== 'NFO' || parts[1] !== 'NIFTY') return null;
  const strike = Number(parts[3]);
  const type = parts[4];
  if (!Number.isFinite(strike) || (type !== 'CE' && type !== 'PE')) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parts[2])) return null;
  return { underlying: 'NIFTY', expiry: parts[2], strike, type };
}

export function kindOf(id: string): InstrumentKind {
  if (id === NIFTY_ID) return 'INDEX';
  if (id.startsWith('NFO:')) return 'OPTION';
  return 'EQUITY';
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Human-readable label, e.g. "NIFTY 10 NOV 26000 CE" or "RELIANCE". */
export function displayName(id: string): string {
  const opt = parseOptionId(id);
  if (opt) {
    const [, m, d] = opt.expiry.split('-').map(Number);
    return `NIFTY ${d} ${MONTHS[m - 1]} ${opt.strike} ${opt.type}`;
  }
  return id.replace(/^NSE:/, '');
}

/** Units per 1 quantity step. Options trade in lots. */
export function lotSize(id: string): number {
  return kindOf(id) === 'OPTION' ? NIFTY_LOT_SIZE : 1;
}

export const isTradeable = (id: string) => kindOf(id) !== 'INDEX';
