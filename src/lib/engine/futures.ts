/**
 * Futures model for MCX mini contracts (LONG / SHORT the current-month future).
 *
 * Not from the Excel workbook: the workbook is an option-buying system whose
 * score is half option-chain data (PCR, OI, Greeks, IV), which futures don't
 * have. This model keeps the workbook's technical factors (EMA trend, VWAP,
 * price action — same rules) and replaces the option-chain half with futures
 * evidence: momentum, volume, day-open position, breakout room, OI buildup
 * and volatility. Max 100. Paper-test it before trusting it with money.
 */
import { istDay, type Technical } from './indicators.ts';
import { livePriceAction } from './priceAction.ts';
import { sideOf, type Candle, type Direction, type EngineConfig, type Factor, type TradePlan } from './types.ts';

export const FUTURES_FACTORS: [key: string, label: string, max: number][] = [
  ['emaTrend', 'EMA Trend', 15],
  ['vwap', 'VWAP Position', 10],
  ['priceAction', 'Price Action', 10],
  ['momentum', 'Momentum (EMA spread / ATR)', 15],
  ['volume', 'Volume Confirmation', 10],
  ['dayOpen', 'Vs Day Open', 10],
  ['oiBuildup', 'OI Buildup', 15],
  ['breakout', 'Breakout / Room to Run', 10],
  ['volatility', 'Volatility Fit', 5],
];

export interface FuturesEvaluation {
  direction: 'LONG' | 'SHORT';
  confidence: number;
  scoreLong: number;
  scoreShort: number;
  factors: Factor[];
  label: string;
  swingSupport: number;
  swingResistance: number;
  dayOpen: number;
  oi: number;
  oiChange: number;
  buildup: string;
  momentum: number;
}

const OI_LOOKBACK = 6; // candles (~30 min of 5-min bars)

/** Classic price/OI reading over the last ~30 minutes. */
export function oiBuildup(c: Candle[]): {
  label: string;
  priceUp: boolean | null;
  oiUp: boolean | null;
  oi: number;
  change: number;
} {
  const n = c.length;
  const last = c[n - 1];
  const then = c[Math.max(0, n - 1 - OI_LOOKBACK)];
  if (last?.oi == null || then?.oi == null || !(last.oi > 0) || !(then.oi > 0)) {
    return { label: 'NO OI DATA', priceUp: null, oiUp: null, oi: last?.oi ?? 0, change: 0 };
  }
  const priceUp = last.c > then.c;
  const oiUp = last.oi > then.oi;
  const label = priceUp ? (oiUp ? 'LONG BUILDUP' : 'SHORT COVERING') : oiUp ? 'SHORT BUILDUP' : 'LONG UNWINDING';
  return { label, priceUp, oiUp, oi: last.oi, change: last.oi - then.oi };
}

function scoreSide(
  dir: 'LONG' | 'SHORT',
  c: Candle[],
  tech: Technical,
  spot: number,
  pa: { bull: number; bear: number },
  ctx: {
    dayOpen: number;
    sessHigh: number;
    sessLow: number;
    swingSupport: number;
    swingResistance: number;
    oi: ReturnType<typeof oiBuildup>;
  },
) {
  const side = sideOf(dir);
  const { ema20, ema50, vwap, atr } = tech.last;
  const emaState = ema20 > ema50 && spot > ema20 ? 1 : ema20 < ema50 && spot < ema20 ? -1 : 0;
  const emaTrend = emaState === side ? 15 : emaState === 0 ? 6 : 0;

  const vwapPct = vwap ? ((spot - vwap) / vwap) * 100 * side : 0;
  const vwapPos = vwapPct > 0.05 ? 10 : vwapPct > 0 ? 5 : 0;

  const priceAction = side > 0 ? pa.bull : pa.bear;

  const m = atr > 0 ? ((ema20 - ema50) / atr) * side : 0;
  const momentum = m >= 1 ? 15 : m >= 0.5 ? 10 : m > 0 ? 5 : 0;

  const last = c[c.length - 1];
  const prev = c.slice(Math.max(0, c.length - 21), c.length - 1);
  const avgVol = prev.length ? prev.reduce((a, x) => a + x.v, 0) / prev.length : 0;
  const candleWithUs = side * (last.c - last.o) > 0;
  const volume = avgVol > 0 && candleWithUs ? (last.v >= avgVol * 1.5 ? 10 : last.v >= avgVol ? 5 : 0) : 0;

  const fromOpen = ctx.dayOpen ? ((spot - ctx.dayOpen) / ctx.dayOpen) * 100 * side : 0;
  const dayOpen = fromOpen > 0.2 ? 10 : fromOpen > 0 ? 5 : 0;

  const o = ctx.oi;
  let oiScore = 0;
  if (o.priceUp != null) {
    if (side > 0) oiScore = o.label === 'LONG BUILDUP' ? 15 : o.label === 'SHORT COVERING' ? 8 : 0;
    else oiScore = o.label === 'SHORT BUILDUP' ? 15 : o.label === 'LONG UNWINDING' ? 8 : 0;
  }

  // Breakout: trading at the session extreme in our direction; otherwise room to the next level.
  const tol = atr * 0.1;
  let breakout = 0;
  if (side > 0) {
    if (spot >= ctx.sessHigh - tol) breakout = 10;
    else if (ctx.swingResistance > 0 && ctx.swingResistance - spot > atr) breakout = 5;
  } else if (spot <= ctx.sessLow + tol) breakout = 10;
  else if (ctx.swingSupport > 0 && spot - ctx.swingSupport > atr) breakout = 5;

  const atrPct = spot > 0 ? (atr / spot) * 100 : 0;
  const volatility = atrPct >= 0.03 && atrPct <= 0.6 ? 5 : 0;

  const values: Record<string, number> = {
    emaTrend,
    vwap: vwapPos,
    priceAction,
    momentum,
    volume,
    dayOpen,
    oiBuildup: oiScore,
    breakout,
    volatility,
  };
  const factors: Factor[] = FUTURES_FACTORS.map(([key, label, max]) => ({ key, label, max, value: values[key] }));
  return { total: factors.reduce((a, f) => a + f.value, 0), factors, momentum: m };
}

export function evaluateFutures(c: Candle[], tech: Technical, spot: number): FuturesEvaluation {
  const pa = livePriceAction(c, tech, 0, 0); // no option-chain OI levels for futures
  const today = istDay(c[c.length - 1].t);
  const session = c.filter((x) => istDay(x.t) === today);
  const dayOpen = session[0]?.o ?? c[0].o;
  const sessHigh = Math.max(...session.map((x) => x.h), spot);
  const sessLow = Math.min(...session.map((x) => x.l), spot);
  const oi = oiBuildup(c);
  const ctx = { dayOpen, sessHigh, sessLow, swingSupport: pa.swingSupport, swingResistance: pa.swingResistance, oi };
  const L = scoreSide('LONG', c, tech, spot, pa, ctx);
  const S = scoreSide('SHORT', c, tech, spot, pa, ctx);
  const long = L.total >= S.total;
  return {
    direction: long ? 'LONG' : 'SHORT',
    confidence: long ? L.total : S.total,
    scoreLong: L.total,
    scoreShort: S.total,
    factors: long ? L.factors : S.factors,
    label: pa.label,
    swingSupport: pa.swingSupport,
    swingResistance: pa.swingResistance,
    dayOpen,
    oi: oi.oi,
    oiChange: oi.change,
    buildup: oi.label,
    momentum: long ? L.momentum : S.momentum,
  };
}

const roundTo = (p: number, tick: number) => (tick > 0 ? Math.round(p / tick) * tick : p);
const clean = (p: number, tick: number) => Number(roundTo(p, tick).toFixed(4));

/** ATR × multiplier risk in price points; lots sized so the stop costs ≤ max risk (capped by max lots). */
export function buildFuturesPlan(dir: Direction, entry: number, atr: number, cfg: EngineConfig): TradePlan | null {
  if ((dir !== 'LONG' && dir !== 'SHORT') || !(entry > 0)) return null;
  const side = sideOf(dir);
  const tick = cfg.tickSize || 0.05;
  let risk = atr * cfg.atrMult;
  if (!(risk > 0)) risk = entry * 0.003;
  risk = Math.max(tick, clean(risk, tick));
  const pv = cfg.pointValue || 1;
  let lots = Math.max(1, Math.floor(cfg.maxRisk / (risk * pv)));
  if (cfg.maxLots > 0) lots = Math.min(lots, cfg.maxLots);
  const qty = lots * (cfg.lotSize || 1);
  const sl = clean(entry - side * risk, tick);
  const target1 = clean(entry + side * risk * cfg.rrTarget, tick);
  const target2 = clean(entry + side * risk * cfg.rrTarget * 1.5, tick);
  return {
    strike: 0,
    direction: dir,
    entry,
    sl,
    target1,
    target2,
    riskPts: risk,
    rewardPts: risk * cfg.rrTarget,
    rr: `1:${cfg.rrTarget.toFixed(1)}`,
    qty,
    maxLoss: risk * pv * qty,
    potentialProfit: risk * cfg.rrTarget * pv * qty,
  };
}
