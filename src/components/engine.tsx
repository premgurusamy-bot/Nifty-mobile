import { StyleSheet, Text, View } from 'react-native';
import type { ScoreBreakdown, Signal } from '../lib/engine/types';
import { FACTOR_LABELS } from '../lib/engine/types';
import { formatNumber } from '../lib/format';
import { colors } from '../theme';
import { Card, styles as ui } from './ui';

export const signalColor = (s: Signal) =>
  s === 'BUY CE' ? colors.up : s === 'BUY PE' ? colors.down : s === 'NO TRADE' ? colors.muted : colors.warn;

/** Two-column key/value table, like the workbook's Field/Value blocks. */
export function KV({ title, rows }: { title: string; rows: [string, string | number, string?][] }) {
  return (
    <Card style={{ gap: 2 }}>
      <Text style={[ui.sectionTitle, { marginTop: 0, marginBottom: 6 }]}>{title}</Text>
      {rows.map(([k, v, color]) => (
        <View key={k} style={s.kvRow}>
          <Text style={s.kvKey}>{k}</Text>
          <Text style={[s.kvVal, color ? { color } : null]} numberOfLines={2}>
            {typeof v === 'number' ? formatNumber(v) : v}
          </Text>
        </View>
      ))}
    </Card>
  );
}

/** Confidence score breakdown (04_Analytics E5:F16) as bars against each factor's max. */
export function Breakdown({ b, total }: { b: ScoreBreakdown; total: number }) {
  return (
    <Card style={{ gap: 8 }}>
      <Text style={[ui.sectionTitle, { marginTop: 0 }]}>Confidence score breakdown</Text>
      {(Object.keys(FACTOR_LABELS) as (keyof ScoreBreakdown)[]).map((k) => {
        const [label, max] = FACTOR_LABELS[k];
        const v = b[k];
        return (
          <View key={k} style={{ gap: 3 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={s.kvKey}>{label}</Text>
              <Text style={s.kvVal}>
                {formatNumber(v, v % 1 ? 2 : 0)} / {max}
              </Text>
            </View>
            <View style={s.track}>
              <View style={[s.fill, { width: `${Math.min(100, (v / max) * 100)}%` }]} />
            </View>
          </View>
        );
      })}
      <View
        style={[s.kvRow, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: 8 }]}
      >
        <Text style={[s.kvKey, { color: colors.text, fontWeight: '700' }]}>TOTAL</Text>
        <Text style={[s.kvVal, { fontWeight: '800' }]}>{formatNumber(total)}</Text>
      </View>
    </Card>
  );
}

export function ConfidenceMeter({ value, watch, high }: { value: number; watch: number; high: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const color = value >= high ? colors.up : value >= watch ? colors.warn : colors.muted;
  return (
    <View style={{ gap: 4 }}>
      <View style={s.meter}>
        <View style={[s.meterFill, { width: `${pct}%`, backgroundColor: color }]} />
        <View style={[s.tick, { left: `${watch}%` }]} />
        <View style={[s.tick, { left: `${high}%` }]} />
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={s.small}>0</Text>
        <Text style={s.small}>
          watch {watch} · trade {high}
        </Text>
        <Text style={s.small}>100</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  kvRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 5,
    gap: 12,
  },
  kvKey: { color: colors.muted, fontSize: 13, flexShrink: 0 },
  kvVal: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
    flexShrink: 1,
  },
  track: { height: 6, backgroundColor: colors.cardAlt, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 6, backgroundColor: colors.accent, borderRadius: 3 },
  meter: { height: 10, backgroundColor: colors.cardAlt, borderRadius: 5, overflow: 'hidden' },
  meterFill: { height: 10, borderRadius: 5 },
  tick: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: colors.text, opacity: 0.6 },
  small: { color: colors.muted, fontSize: 11 },
});
