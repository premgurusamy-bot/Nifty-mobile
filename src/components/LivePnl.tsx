import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { LivePnl } from '../lib/engine/runner';
import type { OpenPosition } from '../lib/engine/types';
import { formatINR, formatNumber, formatSigned } from '../lib/format';
import { colors, pnlColor } from '../theme';
import { Card, styles as ui } from './ui';

const signedINR = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '') + formatINR(Math.abs(n), 0);

/** Big running P&L at the top of the Dashboard: the open trade (live quote) and today's total. */
export function LivePnlCard({
  live,
  position,
  demo,
  profitLock,
  label,
}: {
  live: LivePnl;
  position: OpenPosition | null;
  demo: boolean;
  profitLock: boolean;
  label: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!position) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [position]);

  const ago = live.at != null && !demo ? Math.max(0, Math.round((now - live.at) / 1000)) : null;
  const fresh = live.source === 'TICK' && ago != null && ago <= 10;
  const trade = live.tradePnl;
  const pct = trade != null && live.invested ? (trade / live.invested) * 100 : null;
  const move = position && live.ltp != null ? (position.side ?? 1) * (live.ltp - position.entry) : null;

  return (
    <Card style={{ gap: 8, borderColor: trade == null ? colors.border : pnlColor(trade), borderWidth: 1 }}>
      <View style={st.head}>
        <Text style={[ui.sectionTitle, { marginTop: 0 }]}>{position ? `Live P&L · ${label}` : "Today's P&L"}</Text>
        {position ? (
          <View style={st.head}>
            <View style={[st.dot, { backgroundColor: fresh ? colors.up : colors.muted }]} />
            <Text style={st.small}>
              {demo ? 'demo · per refresh' : ago == null ? 'waiting for price' : fresh ? `live · ${ago}s ago` : `${ago}s ago`}
            </Text>
          </View>
        ) : null}
      </View>

      {position ? (
        <>
          <Text accessibilityLabel="Open trade P&L" style={[st.big, { color: trade == null ? colors.muted : pnlColor(trade) }]}>
            {trade == null ? '—' : signedINR(trade)}
          </Text>
          <Text style={ui.muted}>
            {live.ltp != null ? `${formatNumber(live.ltp)} now` : 'no price yet'}
            {move != null ? ` (${formatSigned(move)} from ${formatNumber(position.entry)})` : ''}
            {pct != null ? ` · ${formatSigned(pct, 1)}%` : ''}
            {position.partialBooked ? ` · incl. ${signedINR(position.partialPnl)} booked at T1` : ''}
          </Text>
          {profitLock ? (
            <Text style={[st.small, { color: position.lockedPnl != null ? colors.up : colors.muted }]}>
              {position.lockedPnl != null
                ? position.lockedPnl > 0
                  ? `Profit lock: ${formatINR(position.lockedPnl, 0)} secured · best ${formatINR(position.peakPnl ?? 0, 0)}`
                  : `Day floor: this trade may lose ${formatINR(-position.lockedPnl, 0)} at most · best ${formatINR(Math.max(0, position.peakPnl ?? 0), 0)}`
                : `Profit lock: not engaged yet · best ${formatINR(Math.max(0, position.peakPnl ?? 0), 0)}`}
            </Text>
          ) : null}
        </>
      ) : null}

      <View style={st.row}>
        <View style={{ flex: 1 }}>
          <Text style={st.small}>Booked today</Text>
          <Text style={[st.mid, { color: pnlColor(live.realizedToday) }]}>{signedINR(live.realizedToday)}</Text>
        </View>
        <View style={{ flex: 1, alignItems: 'flex-end' }}>
          <Text style={st.small}>{position ? 'Today incl. open trade' : 'No open trade'}</Text>
          <Text accessibilityLabel="Today total P&L" style={[st.mid, { color: pnlColor(live.dayPnl) }]}>
            {signedINR(live.dayPnl)}
          </Text>
        </View>
      </View>
    </Card>
  );
}

const st = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  small: { color: colors.muted, fontSize: 12 },
  big: { fontSize: 34, fontWeight: '800', letterSpacing: 0.5 },
  mid: { fontSize: 18, fontWeight: '700' },
  row: { flexDirection: 'row', marginTop: 4 },
});
