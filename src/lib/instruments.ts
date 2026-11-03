/**
 * Instrument definitions and ID helpers.
 *
 * IDs:
 *   Index:   "NSE:NIFTY 50"
 *   Equity:  "NSE:RELIANCE"
 *   Option:  "NFO:NIFTY:2026-11-10:26000:CE"
 *   Other broker instrument (e.g. a holding outside the watchlist):
 *            "EXT:NSE_EQ:1234:TATASTEEL"   (segment, Dhan security id, trading symbol)
 */

export type InstrumentKind = 'INDEX' | 'EQUITY' | 'OPTION' | 'EXTERNAL';
export type OptionType = 'CE' | 'PE';

export interface EquityDef {
  symbol: string;
  name: string;
  /** Reference price used to seed the simulator (not live data). */
  basePrice: number;
  /** Sensitivity to the overall market move in the simulator. */
  beta: number;
  /** Dhan security id (= NSE token) in the NSE_EQ segment. The server re-checks these against Dhan's scrip master. */
  dhanId: string;
}

export const NIFTY_ID = 'NSE:NIFTY 50';
export const NIFTY_BASE = 26000;

/**
 * NIFTY derivatives contract size. NSE revises lot sizes periodically —
 * verify against the latest NSE circular before relying on this.
 */
export const NIFTY_LOT_SIZE = 65;
let niftyLot = NIFTY_LOT_SIZE;
/** Override the lot size at runtime (the Dhan server reports the current one from the scrip master). */
export const setNiftyLotSize = (n: number) => {
  if (Number.isInteger(n) && n > 0) niftyLot = n;
};
export const niftyLotSize = () => niftyLot;

/** Dhan identifiers for the NIFTY 50 index (segment IDX_I). */
export const NIFTY_DHAN_ID = '13';
export const NIFTY_STRIKE_STEP = 50;

/** Selection of NIFTY 50 constituents. Base prices are approximate seeds for simulation only. */
export const EQUITIES: EquityDef[] = [
  { symbol: 'RELIANCE', name: 'Reliance Industries', basePrice: 1480, beta: 1.0, dhanId: '2885' },
  { symbol: 'HDFCBANK', name: 'HDFC Bank', basePrice: 1000, beta: 0.9, dhanId: '1333' },
  { symbol: 'ICICIBANK', name: 'ICICI Bank', basePrice: 1400, beta: 1.1, dhanId: '4963' },
  { symbol: 'INFY', name: 'Infosys', basePrice: 1550, beta: 0.8, dhanId: '1594' },
  { symbol: 'TCS', name: 'Tata Consultancy Services', basePrice: 3100, beta: 0.7, dhanId: '11536' },
  { symbol: 'BHARTIARTL', name: 'Bharti Airtel', basePrice: 2000, beta: 0.8, dhanId: '10604' },
  { symbol: 'ITC', name: 'ITC', basePrice: 410, beta: 0.6, dhanId: '1660' },
  { symbol: 'SBIN', name: 'State Bank of India', basePrice: 900, beta: 1.3, dhanId: '3045' },
  { symbol: 'LT', name: 'Larsen & Toubro', basePrice: 3900, beta: 1.1, dhanId: '11483' },
  { symbol: 'HINDUNILVR', name: 'Hindustan Unilever', basePrice: 2450, beta: 0.5, dhanId: '1394' },
  { symbol: 'KOTAKBANK', name: 'Kotak Mahindra Bank', basePrice: 2100, beta: 1.0, dhanId: '1922' },
  { symbol: 'AXISBANK', name: 'Axis Bank', basePrice: 1200, beta: 1.2, dhanId: '5900' },
  { symbol: 'BAJFINANCE', name: 'Bajaj Finance', basePrice: 1000, beta: 1.4, dhanId: '317' },
  { symbol: 'MARUTI', name: 'Maruti Suzuki', basePrice: 16000, beta: 0.9, dhanId: '10999' },
  { symbol: 'SUNPHARMA', name: 'Sun Pharmaceutical', basePrice: 1700, beta: 0.6, dhanId: '3351' },
  { symbol: 'TITAN', name: 'Titan Company', basePrice: 3700, beta: 1.0, dhanId: '3506' },
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

export interface ExternalRef {
  segment: string;
  securityId: string;
  symbol: string;
}

export const externalId = (r: ExternalRef) => `EXT:${r.segment}:${r.securityId}:${r.symbol}`;

export function parseExternalId(id: string): ExternalRef | null {
  const m = /^EXT:([A-Z_]+):(\d+):(.+)$/.exec(id);
  return m ? { segment: m[1], securityId: m[2], symbol: m[3] } : null;
}

export function kindOf(id: string): InstrumentKind {
  if (id === NIFTY_ID) return 'INDEX';
  if (id.startsWith('EXT:')) return 'EXTERNAL';
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
  const ext = parseExternalId(id);
  if (ext) return ext.symbol;
  return id.replace(/^NSE:/, '');
}

/** Units per 1 quantity step. Options trade in lots. */
export function lotSize(id: string): number {
  return kindOf(id) === 'OPTION' ? niftyLot : 1;
}

export const isTradeable = (id: string) => kindOf(id) !== 'INDEX';
