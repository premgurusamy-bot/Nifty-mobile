/**
 * Candle chart (5-minute candles of the selected index) with the app's indicators: EMA 20 / 50 and
 * VWAP on the price, RSI and ADX (+DI / −DI) panels below, the armed setup's trigger, and markers for
 * the app's entries / exits and Market Memory's tops and bottoms. Pure SVG (react-native-svg).
 */
import { useMemo, useState } from 'react';
import { Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, G, Line, Path, Polygon, Rect, Text as SvgText } from 'react-native-svg';
import type { Candle } from '../lib/engine/types';
import { indicatorSeries } from '../lib/memory/indicators';
import { colors } from '../theme';

export interface ChartMarker {
  t: number;
  price: number;
  kind: 'BUY_CE' | 'BUY_PE' | 'EXIT' | 'BOTTOM' | 'TOP';
  label?: string;
}

interface Props {
  /** All candles (indicators are computed on all of them; the last `show` are drawn). */
  candles: Candle[];
  show: number;
  markers?: ChartMarker[];
  /** A horizontal level (e.g. the armed setup's trigger). */
  level?: { price: number; label: string } | null;
}

const PRICE_H = 240;
const PANEL_H = 64;
const GAP = 14;
const AXIS_W = 52;
const hm = (t: number) => new Date(t + 5.5 * 3600_000).toISOString().slice(11, 16);

export function CandleChart({ candles, show, markers = [], level }: Props) {
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);
  const ind = useMemo(() => indicatorSeries(candles), [candles]);
  const from = Math.max(0, candles.length - show);
  const cs = candles.slice(from);
  const is = ind.slice(from);
  const totalH = PRICE_H + 2 * (PANEL_H + GAP) + 16;

  if (!cs.length) return <View onLayout={onLayout} style={{ height: 40 }} />;
  const plotW = Math.max(0, width - AXIS_W);
  const step = cs.length > 0 ? plotW / cs.length : 0;
  const bodyW = Math.max(1, Math.min(10, step * 0.65));
  const x = (i: number) => i * step + step / 2;

  // Price scale: candles, EMAs, VWAP, level and markers all fit.
  let lo = Infinity;
  let hi = -Infinity;
  cs.forEach((c, i) => {
    lo = Math.min(lo, c.l, is[i].ema20, is[i].vwap);
    hi = Math.max(hi, c.h, is[i].ema20, is[i].vwap);
  });
  if (level && level.price > 0) {
    lo = Math.min(lo, level.price);
    hi = Math.max(hi, level.price);
  }
  const pad = (hi - lo) * 0.06 || 1;
  lo -= pad;
  hi += pad;
  const y = (p: number) => 6 + (1 - (p - lo) / (hi - lo)) * (PRICE_H - 12);
  const line = (vals: number[], top: number, h: number, min: number, max: number) =>
    vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${(top + (1 - (v - min) / (max - min || 1)) * h).toFixed(1)}`).join(' ');
  const pricePath = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => lo + (hi - lo) * f);
  const timeIdx = cs.length > 1 ? [0, Math.floor(cs.length / 3), Math.floor((2 * cs.length) / 3), cs.length - 1] : [0];
  const rsiTop = PRICE_H + GAP;
  const adxTop = rsiTop + PANEL_H + GAP;
  const idxOf = (t: number) => {
    let best = -1;
    for (let i = 0; i < cs.length; i++) if (cs[i].t <= t) best = i;
    return best;
  };
  const shown = markers.map((m) => ({ ...m, i: idxOf(m.t) })).filter((m) => m.i >= 0 && m.price >= lo && m.price <= hi);

  return (
    <View onLayout={onLayout}>
      {width > 0 ? (
        <Svg width={width} height={totalH}>
          {/* price grid + axis */}
          {ticks.map((p) => (
            <G key={p}>
              <Line x1={0} x2={plotW} y1={y(p)} y2={y(p)} stroke={colors.border} strokeWidth={0.5} />
              <SvgText x={plotW + 4} y={y(p) + 3} fill={colors.muted} fontSize={9}>
                {Math.round(p).toLocaleString('en-IN')}
              </SvgText>
            </G>
          ))}
          {/* candles */}
          {cs.map((c, i) => {
            const up = c.c >= c.o;
            const col = up ? colors.up : colors.down;
            const top = y(Math.max(c.o, c.c));
            const h = Math.max(1, Math.abs(y(c.o) - y(c.c)));
            return (
              <G key={c.t}>
                <Line x1={x(i)} x2={x(i)} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth={1} />
                <Rect x={x(i) - bodyW / 2} y={top} width={bodyW} height={h} fill={col} />
              </G>
            );
          })}
          {/* EMA 20 / 50, VWAP */}
          <Path d={pricePath(is.map((v) => v.ema20))} stroke="#F59E0B" strokeWidth={1.4} fill="none" />
          <Path d={pricePath(is.map((v) => v.ema50))} stroke="#A855F7" strokeWidth={1.4} fill="none" />
          <Path d={pricePath(is.map((v) => v.vwap))} stroke="#3B82F6" strokeWidth={1.2} strokeDasharray="2,3" fill="none" />
          {level && level.price > 0 ? (
            <G>
              <Line x1={0} x2={plotW} y1={y(level.price)} y2={y(level.price)} stroke={colors.warn} strokeWidth={1} strokeDasharray="5,4" />
              <SvgText x={4} y={y(level.price) - 3} fill={colors.warn} fontSize={9}>
                {level.label}
              </SvgText>
            </G>
          ) : null}
          {/* markers */}
          {shown.map((m, k) => {
            const cx = x(m.i);
            const cy = y(m.price);
            const s = 6;
            if (m.kind === 'BUY_CE' || m.kind === 'BOTTOM')
              return <Polygon key={k} points={`${cx},${cy + 2} ${cx - s},${cy + 2 + s * 1.6} ${cx + s},${cy + 2 + s * 1.6}`} fill={m.kind === 'BUY_CE' ? colors.up : 'none'} stroke={colors.up} strokeWidth={1.4} />;
            if (m.kind === 'BUY_PE' || m.kind === 'TOP')
              return <Polygon key={k} points={`${cx},${cy - 2} ${cx - s},${cy - 2 - s * 1.6} ${cx + s},${cy - 2 - s * 1.6}`} fill={m.kind === 'BUY_PE' ? colors.down : 'none'} stroke={colors.down} strokeWidth={1.4} />;
            return <Circle key={k} cx={cx} cy={cy} r={4} fill={colors.text} stroke={colors.bg} strokeWidth={1} />;
          })}
          {/* RSI panel */}
          <Rect x={0} y={rsiTop} width={plotW} height={PANEL_H} fill={colors.card} />
          {[30, 70].map((lv) => (
            <Line key={lv} x1={0} x2={plotW} y1={rsiTop + (1 - lv / 100) * PANEL_H} y2={rsiTop + (1 - lv / 100) * PANEL_H} stroke={colors.border} strokeDasharray="3,3" />
          ))}
          <Path d={line(is.map((v) => v.rsi), rsiTop, PANEL_H, 0, 100)} stroke="#22D3EE" strokeWidth={1.3} fill="none" />
          <SvgText x={plotW + 4} y={rsiTop + 10} fill={colors.muted} fontSize={9}>
            RSI {is.at(-1)!.rsi.toFixed(0)}
          </SvgText>
          {/* ADX panel */}
          <Rect x={0} y={adxTop} width={plotW} height={PANEL_H} fill={colors.card} />
          <Line x1={0} x2={plotW} y1={adxTop + (1 - 20 / 60) * PANEL_H} y2={adxTop + (1 - 20 / 60) * PANEL_H} stroke={colors.border} strokeDasharray="3,3" />
          <Path d={line(is.map((v) => Math.min(60, v.adx)), adxTop, PANEL_H, 0, 60)} stroke={colors.text} strokeWidth={1.4} fill="none" />
          <Path d={line(is.map((v) => Math.min(60, v.pdi)), adxTop, PANEL_H, 0, 60)} stroke={colors.up} strokeWidth={1} fill="none" />
          <Path d={line(is.map((v) => Math.min(60, v.mdi)), adxTop, PANEL_H, 0, 60)} stroke={colors.down} strokeWidth={1} fill="none" />
          <SvgText x={plotW + 4} y={adxTop + 10} fill={colors.muted} fontSize={9}>
            ADX {is.at(-1)!.adx.toFixed(0)}
          </SvgText>
          {/* time axis */}
          {timeIdx.map((i) => (
            <SvgText key={i} x={Math.min(plotW - 24, Math.max(0, x(i) - 12))} y={totalH - 2} fill={colors.muted} fontSize={9}>
              {hm(cs[i].t)}
            </SvgText>
          ))}
        </Svg>
      ) : null}
      <Text style={{ color: colors.muted, fontSize: 11, marginTop: 4 }}>
        <Text style={{ color: '#F59E0B' }}>EMA 20</Text> · <Text style={{ color: '#A855F7' }}>EMA 50</Text> · <Text style={{ color: '#3B82F6' }}>VWAP</Text> ·{' '}
        <Text style={{ color: colors.up }}>▲ CE entry</Text> · <Text style={{ color: colors.down }}>▼ PE entry</Text> · ● exit · △ bottom / ▽ top (Market Memory) ·
        RSI (30/70) · ADX with <Text style={{ color: colors.up }}>+DI</Text> / <Text style={{ color: colors.down }}>−DI</Text>
      </Text>
    </View>
  );
}
