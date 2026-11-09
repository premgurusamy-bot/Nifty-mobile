/**
 * Tradeable instruments and the settings each one needs.
 *
 * INDEX_OPTIONS: the workbook's option-buying system on an NSE index.
 * MCX_FUTURES:   long/short the current-month MCX mini futures contract.
 *
 * Values marked "verify" change from time to time (exchange circulars):
 * the app shows them in Settings and they can be edited. For MCX the
 * current contract's security id, expiry and tick size come from Dhan's
 * instrument list at run time.
 */

export type InstrumentKind = 'INDEX_OPTIONS' | 'MCX_FUTURES';
export type Session = 'NSE' | 'MCX';

export interface CatalogEntry {
  symbol: string;
  label: string;
  kind: InstrumentKind;
  /** Market-data instrument for the engine (index for options; resolved per contract for MCX). */
  underlyingSecurityId: number;
  underlyingSegment: 'IDX_I' | 'MCX_COMM';
  /** Segment orders go to. */
  tradeSegment: 'NSE_FNO' | 'MCX_COMM';
  /** Option strike spacing (index options only). */
  strikeInterval: number;
  /**
   * Order quantity step. Index options: units per lot (orders are in units).
   * MCX: 1 — Dhan takes MCX quantity in lots (its SDK example orders Gold with quantity=1).
   */
  lotSize: number;
  /** ₹ P&L per 1.00 price move per quantity unit (options: 1; MCX: per lot). */
  pointValue: number;
  tickSize: number;
  session: Session;
  /** Default cap on lots per trade (0 = sized only by max risk). */
  maxLots: number;
  /** How the price is quoted and what one lot is. */
  unit: string;
  /** Rough price used only by the demo simulator. */
  demoPrice: number;
}

export const CATALOG: CatalogEntry[] = [
  // --- NSE index options (lot sizes per NSE's latest revision — verify) ---
  {
    symbol: 'NIFTY',
    label: 'NIFTY 50',
    kind: 'INDEX_OPTIONS',
    underlyingSecurityId: 13,
    underlyingSegment: 'IDX_I',
    tradeSegment: 'NSE_FNO',
    strikeInterval: 50,
    lotSize: 65,
    pointValue: 1,
    tickSize: 0.05,
    session: 'NSE',
    maxLots: 25, // under NSE's per-order freeze limit
    unit: 'Option premium, lot 65',
    demoPrice: 24200,
  },
  {
    symbol: 'BANKNIFTY',
    label: 'BANK NIFTY',
    kind: 'INDEX_OPTIONS',
    underlyingSecurityId: 25,
    underlyingSegment: 'IDX_I',
    tradeSegment: 'NSE_FNO',
    strikeInterval: 100,
    lotSize: 30,
    pointValue: 1,
    tickSize: 0.05,
    session: 'NSE',
    maxLots: 25, // under NSE's per-order freeze limit
    unit: 'Option premium, lot 30',
    demoPrice: 54000,
  },
  {
    symbol: 'FINNIFTY',
    label: 'FIN NIFTY',
    kind: 'INDEX_OPTIONS',
    underlyingSecurityId: 27,
    underlyingSegment: 'IDX_I',
    tradeSegment: 'NSE_FNO',
    strikeInterval: 50,
    lotSize: 60,
    pointValue: 1,
    tickSize: 0.05,
    session: 'NSE',
    maxLots: 25, // under NSE's per-order freeze limit
    unit: 'Option premium, lot 60',
    demoPrice: 25500,
  },
  // --- MCX mini futures (contract specs — verify against MCX) ---
  {
    symbol: 'GOLDM',
    label: 'Gold Mini',
    kind: 'MCX_FUTURES',
    underlyingSecurityId: 0,
    underlyingSegment: 'MCX_COMM',
    tradeSegment: 'MCX_COMM',
    strikeInterval: 0,
    lotSize: 1,
    pointValue: 10,
    tickSize: 1,
    session: 'MCX',
    maxLots: 1,
    unit: '₹ per 10 g · lot 100 g · ₹10 per ₹1 move',
    demoPrice: 120000,
  },
  {
    symbol: 'SILVERM',
    label: 'Silver Mini',
    kind: 'MCX_FUTURES',
    underlyingSecurityId: 0,
    underlyingSegment: 'MCX_COMM',
    tradeSegment: 'MCX_COMM',
    strikeInterval: 0,
    lotSize: 1,
    pointValue: 5,
    tickSize: 1,
    session: 'MCX',
    maxLots: 1,
    unit: '₹ per kg · lot 5 kg · ₹5 per ₹1 move',
    demoPrice: 140000,
  },
  {
    symbol: 'CRUDEOILM',
    label: 'Crude Oil Mini',
    kind: 'MCX_FUTURES',
    underlyingSecurityId: 0,
    underlyingSegment: 'MCX_COMM',
    tradeSegment: 'MCX_COMM',
    strikeInterval: 0,
    lotSize: 1,
    pointValue: 10,
    tickSize: 1,
    session: 'MCX',
    maxLots: 1,
    unit: '₹ per barrel · lot 10 bbl · ₹10 per ₹1 move',
    demoPrice: 5600,
  },
  {
    symbol: 'NATGASMINI',
    label: 'Natural Gas Mini',
    kind: 'MCX_FUTURES',
    underlyingSecurityId: 0,
    underlyingSegment: 'MCX_COMM',
    tradeSegment: 'MCX_COMM',
    strikeInterval: 0,
    lotSize: 1,
    pointValue: 250,
    tickSize: 0.1,
    session: 'MCX',
    maxLots: 1,
    unit: '₹ per mmBtu · lot 250 mmBtu · ₹250 per ₹1 move',
    demoPrice: 300,
  },
  {
    symbol: 'LEADMINI',
    label: 'Lead Mini',
    kind: 'MCX_FUTURES',
    underlyingSecurityId: 0,
    underlyingSegment: 'MCX_COMM',
    tradeSegment: 'MCX_COMM',
    strikeInterval: 0,
    lotSize: 1,
    pointValue: 1000,
    tickSize: 0.05,
    session: 'MCX',
    maxLots: 1,
    unit: '₹ per kg · lot 1 MT · ₹1,000 per ₹1 move',
    demoPrice: 180,
  },
  {
    symbol: 'ZINCMINI',
    label: 'Zinc Mini',
    kind: 'MCX_FUTURES',
    underlyingSecurityId: 0,
    underlyingSegment: 'MCX_COMM',
    tradeSegment: 'MCX_COMM',
    strikeInterval: 0,
    lotSize: 1,
    pointValue: 1000,
    tickSize: 0.05,
    session: 'MCX',
    maxLots: 1,
    unit: '₹ per kg · lot 1 MT · ₹1,000 per ₹1 move',
    demoPrice: 270,
  },
  {
    symbol: 'ALUMINI',
    label: 'Aluminium Mini',
    kind: 'MCX_FUTURES',
    underlyingSecurityId: 0,
    underlyingSegment: 'MCX_COMM',
    tradeSegment: 'MCX_COMM',
    strikeInterval: 0,
    lotSize: 1,
    pointValue: 1000,
    tickSize: 0.05,
    session: 'MCX',
    maxLots: 1,
    unit: '₹ per kg · lot 1 MT · ₹1,000 per ₹1 move',
    demoPrice: 250,
  },
];

export const catalogEntry = (symbol: string) => CATALOG.find((c) => c.symbol === symbol) ?? null;

const pad = (n: number) => String(n).padStart(2, '0');

/** n-th weekday (0 = Sun) of a month, as a UTC date number. */
function nthWeekday(y: number, m: number, weekday: number, n: number) {
  const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}

/**
 * MCX closes at 23:55 IST while the US is on standard time (roughly early
 * Nov → mid Mar) and 23:30 IST during US daylight saving time.
 */
export function mcxCloseMinutes(ms: number): number {
  const d = new Date(ms + 5.5 * 3600_000);
  const y = d.getUTCFullYear();
  const key = `${y}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const dstStart = `${y}-03-${pad(nthWeekday(y, 2, 0, 2))}`; // 2nd Sunday of March
  const dstEnd = `${y}-11-${pad(nthWeekday(y, 10, 0, 1))}`; // 1st Sunday of November
  const usDst = key >= dstStart && key < dstEnd;
  return usDst ? 23 * 60 + 30 : 23 * 60 + 55;
}

/** Trading hours for a session (exchange holidays are not modelled). */
export function sessionOpen(ms: number, session: Session): boolean {
  const d = new Date(ms + 5.5 * 3600_000);
  const wd = d.getUTCDay();
  if (wd === 0 || wd === 6) return false;
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (session === 'MCX') return mins >= 9 * 60 && mins <= mcxCloseMinutes(ms);
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

export const sessionLabel = (s: Session, ms = Date.now()) =>
  s === 'MCX' ? `MCX 09:00–${mcxCloseMinutes(ms) === 23 * 60 + 55 ? '23:55' : '23:30'} IST` : 'NSE 09:15–15:30 IST';
