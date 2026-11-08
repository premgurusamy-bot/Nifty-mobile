/** Trend finder: which way each watched index is trending, since when, how strong, and is it ending. */
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, Card, Empty, styles as ui } from '../../components/ui';
import { catalogEntry } from '../../lib/engine/catalog';
import type { TrendPhase, TrendReport } from '../../lib/engine/trend';
import { formatNumber, formatSigned } from '../../lib/format';
import { useEngine } from '../../state/EngineContext';
import { colors } from '../../theme';

const hhmm = (ms: number) => new Date(ms + 5.5 * 3600_000).toISOString().slice(11, 16);
const dayOf = (ms: number) => new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10);
const dur = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);

const PHASE: Record<TrendPhase, { color: string; text: string }> = {
  STARTING: { color: colors.up, text: 'JUST STARTED' },
  RUNNING: { color: colors.up, text: 'RUNNING' },
  MATURE: { color: colors.warn, text: 'MATURE' },
  EXHAUSTING: { color: colors.warn, text: 'TIRING' },
  REVERSING: { color: colors.down, text: 'BREAKING' },
  SIDEWAYS: { color: colors.muted, text: 'SIDEWAYS' },
};

function TrendCard({ sym, t }: { sym: string; t: TrendReport }) {
  const ph = PHASE[t.phase];
  const dirColor = t.direction === 'UP' ? colors.up : t.direction === 'DOWN' ? colors.down : colors.muted;
  const arrow = t.direction === 'UP' ? '▲ UP' : t.direction === 'DOWN' ? '▼ DOWN' : `◆ SIDEWAYS (leans ${t.lean.toLowerCase()})`;
  const started = t.startedAt
    ? `${dayOf(t.startedAt) === dayOf(t.at) ? '' : `${dayOf(t.startedAt).slice(5)} `}${hhmm(t.startedAt)}`
    : '—';
  return (
    <Card style={{ gap: 10, borderColor: ph.color, borderWidth: 1 }}>
      <View style={st.head}>
        <Text style={[ui.title, { fontSize: 20 }]}>{catalogEntry(sym)?.label ?? sym}</Text>
        <Text style={[st.chip, { color: ph.color, borderColor: ph.color }]}>{ph.text}</Text>
      </View>
      <Text style={[st.big, { color: dirColor }]}>{arrow}</Text>
      <View style={st.barTrack} accessibilityLabel={`Trend strength ${t.strength} of 100`}>
        <View style={[st.barFill, { width: `${t.strength}%`, backgroundColor: dirColor }]} />
      </View>
      <Text style={ui.muted}>Strength {t.strength}/100 · ADX {t.adx.toFixed(0)} {t.adxRising ? '↑' : '↓'} · RSI {t.rsi.toFixed(0)}</Text>
      <Text style={ui.title}>{t.verdict}</Text>

      <View style={st.grid}>
        <Cell k="Started" v={`${started} @ ${t.startPrice != null ? formatNumber(t.startPrice) : '—'}`} />
        <Cell k="Running for" v={dur(t.ageMin)} />
        <Cell k="Move" v={`${formatSigned(t.movePts, 1)} pts (${formatSigned(t.movePct, 2)}%)`} color={t.movePts >= 0 ? colors.up : colors.down} />
        <Cell k="In ATRs" v={`${Math.abs(t.moveAtr).toFixed(1)} ATR`} />
        <Cell
          k="Typical trend here"
          v={t.typicalMin != null ? `${dur(t.typicalMin)} (${t.pastTrends} seen)` : 'not enough history'}
        />
        <Cell k="Age vs past" v={t.agePercentile != null ? `longer than ${t.agePercentile}%` : '—'} />
        <Cell k="15-min chart" v={t.higherTf} color={t.higherTf === 'UP' ? colors.up : t.higherTf === 'DOWN' ? colors.down : colors.muted} />
        <Cell k="From EMA20" v={`${formatSigned(t.stretchAtr, 1)} ATR`} />
        <Cell k="Last swing high" v={t.swingHigh != null ? formatNumber(t.swingHigh) : '—'} />
        <Cell k="Last swing low" v={t.swingLow != null ? formatNumber(t.swingLow) : '—'} />
      </View>

      <Text style={st.label}>Is it ending?</Text>
      {t.warnings.length ? (
        t.warnings.map((w) => (
          <Text key={w} style={{ color: colors.warn }}>
            • {w}
          </Text>
        ))
      ) : (
        <Text style={{ color: colors.up }}>No ending signs yet.</Text>
      )}

      {t.today.length ? (
        <>
          <Text style={st.label}>Today&apos;s trends</Text>
          {t.today.map((s, i) => (
            <Text key={s.start} style={[ui.muted, i === t.today.length - 1 && { color: colors.text }]}>
              {s.dir === 'UP' ? '▲' : '▼'} {dayOf(s.start) === dayOf(t.at) ? hhmm(s.start) : `${dayOf(s.start).slice(5)} ${hhmm(s.start)}`}–
              {i === t.today.length - 1 ? 'now' : hhmm(s.end)} · {dur(s.minutes)} ·{' '}
              {formatSigned(s.movePts, 0)} pts
            </Text>
          ))}
        </>
      ) : null}
      <Text style={[ui.muted, { fontSize: 11 }]}>
        As of the {hhmm(t.at)} candle · price {formatNumber(t.price)}
      </Text>
    </Card>
  );
}

function Cell({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <View style={st.cell}>
      <Text style={st.label}>{k}</Text>
      <Text style={[ui.title, { fontSize: 15 }, color ? { color } : null]}>{v}</Text>
    </View>
  );
}

export default function TrendScreen() {
  const { snap, busy, refresh } = useEngine();
  const trend = snap?.trend ?? {};
  const syms = Object.keys(trend);
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={ui.muted}>
        The trend is your friend: trade with it, take profits quicker when it&apos;s mature or tiring, and stay out
        when it breaks or goes sideways. Updates with every refresh{snap?.watch ? ' for each watched index' : ''}.
      </Text>
      {syms.length ? (
        syms.map((s) => <TrendCard key={s} sym={s} t={trend[s]} />)
      ) : (
        <Empty title="No candles yet" hint="Refresh to load the market — the trend needs at least 30 five-minute candles." />
      )}
      <Button label={busy ? 'Refreshing…' : 'Refresh now'} onPress={() => void refresh().catch(() => {})} disabled={busy} />
      <Text style={[ui.muted, { fontSize: 12 }]}>
        How it works: direction from EMA20 vs EMA50 on 5-min candles, strength from ADX. The start is the turning
        point before the EMAs crossed (the lowest low of an uptrend, the highest high of a downtrend). Age counts
        market time only. Ending signs: strength fading, a new high/low with weaker RSI, a close back through EMA20,
        a broken swing low/high, price stretched far from EMA20, a trend older than most recent ones, and the
        15-min chart disagreeing. Guidance only — the engine&apos;s entry rules don&apos;t use it.
      </Text>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, fontWeight: '800', fontSize: 12 },
  big: { fontSize: 28, fontWeight: '800' },
  barTrack: { height: 8, borderRadius: 4, backgroundColor: colors.cardAlt, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 10 },
  cell: { width: '50%', gap: 2, paddingRight: 8 },
  label: { color: colors.muted, fontSize: 12 },
});
