/**
 * Market Memory — candle indicators, computed from the 5-minute candles themselves (so the same
 * numbers come out in every app version): EMA 20 / 50, session VWAP, RSI 14, ADX 14 with ±DI, ATR 14.
 * Pure.
 */
import type { Candle } from '../engine/types.ts';

export interface CandleIndicators {
  ema20: number;
  ema50: number;
  vwap: number;
  rsi: number;
  adx: number;
  pdi: number;
  mdi: number;
  atr: number;
}

const istDay = (t: number) => new Date(t + 5.5 * 3600_000).toISOString().slice(0, 10);

/** Indicator values at every candle (index-aligned with `c`). */
export function indicatorSeries(c: Candle[]): CandleIndicators[] {
  const n = c.length;
  const out: CandleIndicators[] = new Array(n);
  const k20 = 2 / 21;
  const k50 = 2 / 51;
  let e20 = 0;
  let e50 = 0;
  // VWAP (resets each IST day; volume-weighted when the feed has volume, else the typical price average)
  let day = '';
  let pv = 0;
  let vol = 0;
  let tpSum = 0;
  let tpN = 0;
  // Wilder smoothing
  const N = 14;
  let gain = 0;
  let loss = 0;
  let trS = 0;
  let pdmS = 0;
  let mdmS = 0;
  let adx = 0;
  let dxCount = 0;
  let dxSum = 0;
  for (let i = 0; i < n; i++) {
    const x = c[i];
    e20 = i === 0 ? x.c : e20 + k20 * (x.c - e20);
    e50 = i === 0 ? x.c : e50 + k50 * (x.c - e50);
    const d = istDay(x.t);
    if (d !== day) {
      day = d;
      pv = vol = tpSum = tpN = 0;
    }
    const tp = (x.h + x.l + x.c) / 3;
    pv += tp * (x.v || 0);
    vol += x.v || 0;
    tpSum += tp;
    tpN++;
    const vwap = vol > 0 ? pv / vol : tpSum / tpN;

    let rsi = 50;
    let pdi = 0;
    let mdi = 0;
    if (i > 0) {
      const p = c[i - 1];
      const ch = x.c - p.c;
      const up = Math.max(0, ch);
      const dn = Math.max(0, -ch);
      const tr = Math.max(x.h - x.l, Math.abs(x.h - p.c), Math.abs(x.l - p.c));
      const upMove = x.h - p.h;
      const downMove = p.l - x.l;
      const pdm = upMove > downMove && upMove > 0 ? upMove : 0;
      const mdm = downMove > upMove && downMove > 0 ? downMove : 0;
      if (i <= N) {
        gain += up / N;
        loss += dn / N;
        trS += tr;
        pdmS += pdm;
        mdmS += mdm;
      } else {
        gain = (gain * (N - 1) + up) / N;
        loss = (loss * (N - 1) + dn) / N;
        trS = trS - trS / N + tr;
        pdmS = pdmS - pdmS / N + pdm;
        mdmS = mdmS - mdmS / N + mdm;
      }
      rsi = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
      if (trS > 0) {
        pdi = (100 * pdmS) / trS;
        mdi = (100 * mdmS) / trS;
      }
      const dx = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
      if (i >= N) {
        if (dxCount < N) {
          dxSum += dx;
          dxCount++;
          adx = dxSum / dxCount;
        } else adx = (adx * (N - 1) + dx) / N;
      }
    }
    out[i] = { ema20: e20, ema50: e50, vwap, rsi, adx, pdi, mdi, atr: i > 0 ? trS / Math.min(i, N) : x.h - x.l };
  }
  return out;
}
