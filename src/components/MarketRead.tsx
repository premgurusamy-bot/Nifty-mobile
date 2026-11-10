/** Dashboard cards: market breadth (advances / declines) and the pre-market report. */
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { groupLabel, type Breadth } from '../lib/breadth';
import type { PreMarketReport } from '../lib/premarket';
import { useAlerts } from '../state/AlertsContext';
import { colors } from '../theme';
import { Card, styles as ui } from './ui';

const LEVEL_COLOR: Record<string, string> = {
  'STRONG UP': colors.up,
  UP: colors.up,
  MIXED: colors.warn,
  DOWN: colors.down,
  'STRONG DOWN': colors.down,
};
const pct = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}%`;
const r0 = (n: number) => Math.round(n).toLocaleString('en-IN');
const ist = (ms: number) => new Date(ms + 5.5 * 3600_000).toISOString().slice(11, 16);

function BreadthRow({ b }: { b: Breadth }) {
  const total = b.advances + b.declines + b.unchanged || 1;
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: colors.text, fontWeight: '700' }}>
        {groupLabel(b.group)} · <Text style={{ color: LEVEL_COLOR[b.level] }}>{b.level.toLowerCase()}</Text>
        <Text style={{ color: colors.muted, fontWeight: '400' }}> · {ist(b.at)} IST</Text>
      </Text>
      <View style={{ flexDirection: 'row', height: 10, borderRadius: 5, overflow: 'hidden', backgroundColor: colors.cardAlt }}>
        <View style={{ flex: b.advances / total, backgroundColor: colors.up }} />
        <View style={{ flex: b.unchanged / total, backgroundColor: colors.muted }} />
        <View style={{ flex: b.declines / total, backgroundColor: colors.down }} />
      </View>
      <Text style={{ color: colors.text }}>
        <Text style={{ color: colors.up }}>{b.advances} up</Text> · <Text style={{ color: colors.down }}>{b.declines} down</Text>
        {b.unchanged ? ` · ${b.unchanged} flat` : ''} · weighted{' '}
        <Text style={{ color: b.weightedPct >= 0 ? colors.up : colors.down }}>{pct(b.weightedPct)}</Text>
        {b.counted < b.total ? <Text style={{ color: colors.muted }}> ({b.counted} of {b.total} priced)</Text> : null}
      </Text>
      {b.narrow ? <Text style={{ color: colors.warn, fontSize: 12 }}>Narrow move: a few heavyweights carry the index, most stocks go the other way.</Text> : null}
      {b.up.length || b.down.length ? (
        <Text style={[ui.muted, { fontSize: 12 }]}>
          {b.up.length ? `Pushing up: ${b.up.map((m) => `${m.symbol} ${pct(m.pct)}`).join(', ')}` : ''}
          {b.up.length && b.down.length ? '\n' : ''}
          {b.down.length ? `Dragging: ${b.down.map((m) => `${m.symbol} ${pct(m.pct)}`).join(', ')}` : ''}
        </Text>
      ) : null}
    </View>
  );
}

export function BreadthCard({ breadth }: { breadth: Partial<Record<'NIFTY' | 'BANKNIFTY', Breadth>> }) {
  const rows = (['NIFTY', 'BANKNIFTY'] as const).map((g) => breadth[g]).filter((b): b is Breadth => !!b);
  if (!rows.length) return null;
  return (
    <Card style={{ gap: 10 }}>
      <Text style={[ui.sectionTitle, { marginTop: 0 }]}>Advances / declines</Text>
      {rows.map((b) => (
        <BreadthRow key={b.group} b={b} />
      ))}
      <Text style={[ui.muted, { fontSize: 11 }]}>
        From the index stocks&apos; quotes, once a minute. Weighted = the stocks by their index weight (close to the index move). The advisor skips a setup when breadth is strongly against it.
      </Text>
    </Card>
  );
}

export function PreMarketCard({ report, onUpdate, busy }: { report: PreMarketReport | null; onUpdate: () => Promise<void>; busy: boolean }) {
  const { speakPreMarket } = useAlerts();
  const [msg, setMsg] = useState('');
  const update = () => {
    setMsg('');
    void onUpdate().catch((e) => setMsg((e as Error).message));
  };
  return (
    <Card style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Text style={[ui.sectionTitle, { marginTop: 0, flexShrink: 1 }]}>Pre-market report</Text>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <Pressable onPress={update} disabled={busy} accessibilityRole="button" accessibilityLabel="Update the pre-market report" style={btn}>
            <Text style={{ color: colors.text, fontWeight: '700' }}>{busy ? '…' : '↻ Update'}</Text>
          </Pressable>
          {report ? (
            <Pressable onPress={speakPreMarket} accessibilityRole="button" accessibilityLabel="Speak the pre-market report" style={btn}>
              <Text style={{ color: colors.text, fontWeight: '700' }}>🔊</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      {report ? (
        <>
          <Text style={ui.muted}>
            {ist(report.at)} IST ·{' '}
            {report.phase === 'BEFORE' ? 'yesterday only (pre-open prices from 9:00, settled about 9:08)' : report.phase === 'PREOPEN' ? 'with pre-open prices' : 'made before the open'}
          </Text>
          {report.items.map((i) => (
            <View key={i.symbol} style={{ gap: 2 }}>
              <Text style={{ color: colors.text, fontWeight: '700' }}>
                {i.label} ·{' '}
                <Text style={{ color: i.bias === 'BULLISH' ? colors.up : i.bias === 'BEARISH' ? colors.down : colors.warn }}>
                  {i.bias === 'BULLISH' ? 'leans up' : i.bias === 'BEARISH' ? 'leans down' : 'no clear side'}
                </Text>
                {i.gapPct != null ? (
                  <Text style={{ color: colors.muted, fontWeight: '400' }}>
                    {' '}
                    · gap {pct(i.gapPct)} ({i.gapFrom === 'INDEX' ? 'pre-open index' : 'pre-open stocks'})
                  </Text>
                ) : null}
              </Text>
              <Text style={[ui.muted, { fontSize: 12 }]}>
                Yesterday close {r0(i.prevClose)}
                {i.dayChangePct != null ? ` (${pct(i.dayChangePct)})` : ''} · high {r0(i.prevHigh)} · low {r0(i.prevLow)} · closed at {i.closePos.toFixed(0)}% of the range
                {i.trendAtClose ? ` · ${i.trendAtClose.toLowerCase()} at the close` : ''}
              </Text>
              <Text style={[ui.muted, { fontSize: 12 }]}>
                Pivot {r0(i.pivot)} · R1 {r0(i.r1)} · S1 {r0(i.s1)}
              </Text>
              {i.signs.length ? <Text style={[ui.muted, { fontSize: 12 }]}>Why: {i.signs.join(', ')}</Text> : null}
              <Text style={{ color: colors.text, fontSize: 13 }}>Plan: {i.plan}</Text>
            </View>
          ))}
        </>
      ) : (
        <Text style={ui.muted}>Builds itself from 8:30 to 9:15 IST on trading days (auto refresh on), or tap Update.</Text>
      )}
      {msg ? <Text style={{ color: colors.down }}>{msg}</Text> : null}
      <Text style={[ui.muted, { fontSize: 11 }]}>
        A read of yesterday and the pre-open, not a forecast. No orders before 9:15: index options have no pre-open session, so the engine takes setups after the open (the gap guard waits after a big gap).
      </Text>
    </Card>
  );
}

const btn = { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, backgroundColor: colors.cardAlt, borderWidth: 1, borderColor: colors.border } as const;
