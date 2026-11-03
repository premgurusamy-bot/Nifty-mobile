import { useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { KV } from '../../components/engine';
import { LineChart } from '../../components/LineChart';
import { Button, Card, Empty, Segmented, Stat, styles as ui } from '../../components/ui';
import { summarizeJournal, type BacktestResult } from '../../lib/engine/backtest';
import { formatNumber, formatSigned } from '../../lib/format';
import { useEngine } from '../../state/EngineContext';
import { colors, pnlColor } from '../../theme';

type Tab = 'JOURNAL' | 'SUMMARY' | 'BACKTEST';

const confirm = (msg: string, onYes: () => void) => {
  if (Platform.OS === 'web') {
    if (globalThis.confirm?.(msg)) onYes();
    return;
  }
  Alert.alert('Are you sure?', msg, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Clear', style: 'destructive', onPress: onYes },
  ]);
};

export default function JournalScreen() {
  const { snap, backtest, resetJournal } = useEngine();
  const [tab, setTab] = useState<Tab>('JOURNAL');
  const [bt, setBt] = useState<BacktestResult | null>(null);
  const [btError, setBtError] = useState<string | null>(null);
  const [btBusy, setBtBusy] = useState(false);

  const journal = snap?.state.journal ?? [];
  const days = summarizeJournal(journal);
  const closed = journal.filter((j) => j.pnl != null);
  const wins = closed.filter((j) => j.pnl! > 0).length;
  const losses = closed.filter((j) => j.pnl! < 0).length;
  const total = closed.reduce((a, j) => a + j.pnl!, 0);

  const runBt = async () => {
    setBtBusy(true);
    setBtError(null);
    try {
      setBt(await backtest());
    } catch (e) {
      setBtError((e as Error).message);
    } finally {
      setBtBusy(false);
    }
  };

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Segmented
        options={[
          { label: 'Journal', value: 'JOURNAL' as Tab },
          { label: 'Summary', value: 'SUMMARY' as Tab },
          { label: 'Backtest', value: 'BACKTEST' as Tab },
        ]}
        value={tab}
        onChange={setTab}
      />

      <Card>
        <View style={{ flexDirection: 'row' }}>
          <Stat label="Closed trades" value={String(closed.length)} />
          <Stat label="Wins / losses" value={`${wins} / ${losses}`} />
          <Stat label="Win rate" value={wins + losses ? `${formatNumber((wins / (wins + losses)) * 100, 0)}%` : '—'} />
        </View>
        <View style={{ flexDirection: 'row', marginTop: 12 }}>
          <Stat label="Total P&L (₹)" value={formatSigned(total, 0)} color={pnlColor(total)} />
          <Stat label="Open trades" value={String(journal.length - closed.length)} />
          <Stat label="Source" value={snap?.demo ? 'Demo' : 'Dhan'} />
        </View>
      </Card>

      {tab === 'JOURNAL' &&
        (journal.length === 0 ? (
          <Empty
            title="No trades logged yet"
            hint="Every confirmed BUY CE / BUY PE signal is logged here automatically, and closed out when SL or a target is hit."
          />
        ) : (
          [...journal].reverse().map((j) => (
            <Card key={j.id} style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={[ui.title, { color: j.direction === 'CE' ? colors.up : colors.down }]}>
                  BUY {j.direction} {j.strike}
                </Text>
                <Text
                  style={{
                    color: j.pnl == null ? colors.warn : pnlColor(j.pnl),
                    fontWeight: '700',
                    fontVariant: ['tabular-nums'],
                  }}
                >
                  {j.pnl == null ? 'OPEN' : `₹${formatSigned(j.pnl, 0)}`}
                </Text>
              </View>
              <Text style={ui.muted}>
                {j.date} {j.time} · spot {formatNumber(j.spot)} · confidence {formatNumber(j.confidence, 1)}
              </Text>
              <Text style={s.line}>
                Entry {formatNumber(j.entry)} · SL {formatNumber(j.sl)} · Target {formatNumber(j.target)}
                {j.exit != null ? ` · Exit ${formatNumber(j.exit)}` : ''}
              </Text>
              <Text style={ui.muted}>
                {j.trend} · PCR {formatNumber(j.pcr, 2)} · {j.oiBias} · IV {formatNumber(j.iv, 1)} · Δ{' '}
                {formatNumber(j.delta, 2)}
              </Text>
              <Text style={s.reason}>{j.entryReason}</Text>
              {j.exitReason ? <Text style={[s.reason, { color: colors.text }]}>{j.exitReason}</Text> : null}
            </Card>
          ))
        ))}

      {tab === 'SUMMARY' &&
        (days.length === 0 ? (
          <Empty title="No closed trades yet" />
        ) : (
          <>
            <Card style={{ gap: 8 }}>
              <Text style={[ui.sectionTitle, { marginTop: 0 }]}>Equity curve (cumulative P&L)</Text>
              <LineChart data={[0, ...days.map((d) => d.cumulative)]} baseline={0} height={160} />
            </Card>
            <Card style={{ padding: 0 }}>
              <View style={[s.tr, s.th]}>
                {['Date', 'Trades', 'W', 'L', 'Day P&L', 'Cumulative'].map((h) => (
                  <Text key={h} style={[s.td, s.thText, h === 'Date' && { flex: 1.6 }]}>
                    {h}
                  </Text>
                ))}
              </View>
              {days.map((d) => (
                <View key={d.date} style={s.tr}>
                  <Text style={[s.td, { flex: 1.6 }]}>{d.date}</Text>
                  <Text style={s.td}>{d.trades}</Text>
                  <Text style={s.td}>{d.wins}</Text>
                  <Text style={s.td}>{d.losses}</Text>
                  <Text style={[s.td, { color: pnlColor(d.pnl) }]}>{formatSigned(d.pnl, 0)}</Text>
                  <Text style={[s.td, { color: pnlColor(d.cumulative) }]}>{formatSigned(d.cumulative, 0)}</Text>
                </View>
              ))}
            </Card>
          </>
        ))}

      {tab === 'BACKTEST' && (
        <>
          <Text style={ui.muted}>
            Replays the trend + price-action + confirmation-break logic on the last 3 days of 5-min candles. Dhan has no
            historical option chain, so OI/PCR/Greeks are not replayed and trades are measured in index points — a
            sanity check on the entry logic, not a P&L forecast.
          </Text>
          <Button label={btBusy ? 'Running…' : 'Run backtest'} onPress={runBt} disabled={btBusy} />
          {btError ? <Text style={{ color: colors.down }}>{btError}</Text> : null}
          {bt ? (
            <>
              <KV
                title={`Backtest · ${bt.candles} candles`}
                rows={[
                  ['Setups armed', String(bt.armed)],
                  ['Confirmed', String(bt.confirmed)],
                  ['Wins / losses / timed out', `${bt.wins} / ${bt.losses} / ${bt.timedOut}`],
                  ['Win rate', `${formatNumber(bt.winRate * 100, 1)}%`],
                  ['Total points', formatSigned(bt.totalPoints, 1), pnlColor(bt.totalPoints)],
                  ['Avg points / trade', formatSigned(bt.avgPoints, 1), pnlColor(bt.avgPoints)],
                ]}
              />
              {bt.trades.map((t, i) => (
                <View key={i} style={s.btRow}>
                  <Text style={[s.line, { color: t.direction === 'CE' ? colors.up : colors.down, width: 30 }]}>
                    {t.direction}
                  </Text>
                  <Text style={[s.line, { flex: 1 }]} numberOfLines={1}>
                    {new Date(t.entryTime + 5.5 * 3600_000).toISOString().slice(5, 16).replace('T', ' ')} ·{' '}
                    {formatNumber(t.entry)} → {formatNumber(t.exit)}
                  </Text>
                  <Text style={[s.line, { color: pnlColor(t.points) }]}>{formatSigned(t.points, 1)}</Text>
                </View>
              ))}
            </>
          ) : null}
        </>
      )}

      {tab === 'JOURNAL' && journal.length > 0 && !snap?.state.position ? (
        <Pressable
          onPress={() =>
            confirm('Clear the trade journal and daily counters? IV history is kept.', () => void resetJournal())
          }
          style={{ padding: 16, alignItems: 'center' }}
        >
          <Text style={{ color: colors.down, fontWeight: '600' }}>Clear journal</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  line: { color: colors.text, fontSize: 13, fontVariant: ['tabular-nums'] },
  reason: { color: colors.muted, fontSize: 12 },
  tr: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  th: { backgroundColor: colors.cardAlt, borderTopLeftRadius: 14, borderTopRightRadius: 14 },
  thText: { color: colors.muted, fontWeight: '700', fontSize: 11 },
  td: { flex: 1, color: colors.text, fontSize: 12, fontVariant: ['tabular-nums'] },
  btRow: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
});
