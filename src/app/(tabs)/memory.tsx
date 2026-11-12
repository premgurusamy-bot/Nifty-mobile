/**
 * Market Memory: every recorded 5-minute candle, the tops and bottoms (moves) with the best strike,
 * key candles and which indicators called them, the indicator scorecard, agreement, best pairs and
 * suggested scoring weights — and export for the machine-learning engine later.
 * Suggestions only: nothing here changes trading.
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { Button, Card, Empty, Segmented, styles as ui } from '../../components/ui';
import { analyse, MIN_MOVES_FOR_WEIGHTS, MIN_SIGNALS, movesCsv, recordsCsv, type MemoryReport, type MoveReport } from '../../lib/memory/analysis';
import { marketMemory, setMemoryEnabled } from '../../lib/memory/fileStore';
import type { CandleRecord } from '../../lib/memory/recorder';
import { shareTextFile } from '../../lib/shareFile';
import { useEngine } from '../../state/EngineContext';
import { colors } from '../../theme';

type Range = 'TODAY' | '7' | '30' | 'ALL';
const hm = (t: number) => new Date(t + 5.5 * 3600_000).toISOString().slice(11, 16);
const n0 = (n: number) => Math.round(n).toLocaleString('en-IN');
const pct = (n: number | null | undefined, d = 0) => (n == null ? '—' : `${n.toFixed(d)}%`);
const sign = (n: number, d = 0) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(d)}`;
const hitColor = (h: number | null, enough: boolean) => (!enough || h == null ? colors.muted : h >= 60 ? colors.up : h < 50 ? colors.down : colors.warn);

const confirm = (title: string, msg: string, yes: string, onYes: () => void) => {
  if (Platform.OS === 'web') {
    if (globalThis.confirm?.(`${title}\n\n${msg}`)) onYes();
    return;
  }
  Alert.alert(title, msg, [
    { text: 'Cancel', style: 'cancel' },
    { text: yes, style: 'destructive', onPress: onYes },
  ]);
};

function MoveCard({ m }: { m: MoveReport }) {
  const up = m.dir === 'UP';
  return (
    <View style={s.move}>
      <Text style={{ color: up ? colors.up : colors.down, fontWeight: '800' }}>
        {up ? '▲ BOTTOM → TOP' : '▼ TOP → BOTTOM'} · {m.s} · {m.day.slice(5)} {hm(m.start.t)}–{hm(m.end.t)}
        {m.open ? ' · still running' : ''}
      </Text>
      <Text style={s.line}>
        {n0(m.start.price)} → {n0(m.end.price)} ({sign(m.pts)} pts, {sign(m.pct, 2)}%) · {m.candles} candle{m.candles === 1 ? '' : 's'}
      </Text>
      {m.best ? (
        <Text style={s.line}>
          Best strike: {m.best.strike} {m.best.side} {m.best.entry.toFixed(1)} → {m.best.exit.toFixed(1)} ({sign(m.best.gainPct)}%, ₹{n0(m.best.perLot)}/lot)
          {m.atmLeg && m.atmLeg.strike !== m.best.strike ? ` · ATM ${m.atmLeg.strike}: ${sign(m.atmLeg.gainPct)}%` : ''}
        </Text>
      ) : (
        <Text style={ui.muted}>Premiums not recorded for this move.</Text>
      )}
      <Text style={s.line}>
        Called by {m.predicted.length} of {m.total} indicators
        {m.predicted.length
          ? `: ${m.predicted
              .slice(0, 8)
              .map((p) => `${p.label.replace(/ \(.*\)$/, '')}${p.lead ? ` (${p.lead} early)` : ''}`)
              .join(', ')}${m.predicted.length > 8 ? '…' : ''}`
          : ''}
      </Text>
      {m.keyCandles.length ? (
        <Text style={ui.muted}>
          Key candles: {m.keyCandles.map((k) => `${hm(k.t)} premium ${sign(k.changePct)}% (${k.agree} agreed before)`).join(' · ')}
        </Text>
      ) : null}
    </View>
  );
}

export default function MemoryScreen() {
  const { snap } = useEngine();
  const confHigh = snap?.config.confHigh ?? 80;
  const [range, setRange] = useState<Range>('7');
  const [symbol, setSymbol] = useState<string | null>(null);
  const [report, setReport] = useState<MemoryReport | null>(null);
  const [records, setRecords] = useState<CandleRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [enabled, setEnabled] = useState(marketMemory.enabled);
  const [showMoves, setShowMoves] = useState(10);

  const load = useCallback(async () => {
    setBusy(true);
    setMsg('');
    try {
      const all = await marketMemory.days();
      const days = range === 'ALL' ? all : range === 'TODAY' ? all.slice(-1) : all.slice(-Number(range));
      const recs = await marketMemory.load(days);
      setRecords(recs);
      setReport(analyse(recs, { confHigh, symbol }));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [range, symbol, confHigh]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const share = (name: string, text: string, mime: string) => {
    setMsg('');
    shareTextFile(name, text, mime).catch((e) => setMsg((e as Error).message));
  };

  const r = report;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Card style={{ gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <Text style={[ui.sectionTitle, { marginTop: 0, flexShrink: 1 }]}>Market Memory</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={ui.muted}>Recording</Text>
            <Switch
              value={enabled}
              onValueChange={(v) => {
                setEnabled(v);
                void setMemoryEnabled(v);
              }}
              accessibilityLabel="Record candles"
            />
          </View>
        </View>
        <Text style={ui.muted}>
          Every 5-minute candle the app sees live (Dhan / Angel One data on this phone) is kept for {marketMemory.keepDays} days with its
          indicators, scores and premiums. Tops and bottoms are marked automatically.
          {marketMemory.recorded ? ` ${marketMemory.recorded} candles recorded since the app started.` : ''}
        </Text>
        {marketMemory.lastError ? <Text style={{ color: colors.down }}>Storage problem: {marketMemory.lastError}</Text> : null}
        <Segmented
          options={[
            { label: 'Today', value: 'TODAY' as Range },
            { label: '7 days', value: '7' as Range },
            { label: '30 days', value: '30' as Range },
            { label: 'All', value: 'ALL' as Range },
          ]}
          value={range}
          onChange={setRange}
        />
        {r && r.symbols.length > 1 ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {[null, ...r.symbols].map((sym) => (
              <Pressable key={sym ?? 'ALL'} onPress={() => setSymbol(sym)} style={[s.chip, symbol === sym && s.chipOn]} accessibilityRole="button">
                <Text style={{ color: symbol === sym ? colors.text : colors.muted, fontWeight: '600' }}>{sym ?? 'All indexes'}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <Text style={ui.muted}>
          {r ? `${r.days.length} day${r.days.length === 1 ? '' : 's'} · ${n0(r.records)} candles · ${r.moves.length} moves` : busy ? 'Loading…' : ''}
        </Text>
        <Button label={busy ? 'Loading…' : 'Refresh'} onPress={() => void load()} disabled={busy} color={colors.cardAlt} />
        {msg ? <Text style={{ color: colors.down }}>{msg}</Text> : null}
      </Card>

      {r && !r.records ? (
        <Empty
          title="Nothing recorded yet"
          hint="Turn on auto refresh during market hours with your Dhan account connected. Each finished 5-minute candle is stored here."
        />
      ) : null}

      {r && r.moves.length ? (
        <Card style={{ gap: 10 }}>
          <Text style={[ui.sectionTitle, { marginTop: 0 }]}>Tops and bottoms (latest first)</Text>
          {r.moves.slice(0, showMoves).map((m) => (
            <MoveCard key={`${m.s}${m.start.t}`} m={m} />
          ))}
          {r.moves.length > showMoves ? <Button label={`Show more (${r.moves.length - showMoves})`} onPress={() => setShowMoves(showMoves + 20)} color={colors.cardAlt} /> : null}
        </Card>
      ) : null}

      {r && r.records ? (
        <Card style={{ gap: 8 }}>
          <Text style={[ui.sectionTitle, { marginTop: 0 }]}>Indicator scorecard</Text>
          <Text style={ui.muted}>
            Hit rate = the index moved the indicator&apos;s way over the next 15 minutes. Grey = fewer than {MIN_SIGNALS} signals (not reliable yet).
            ₹/lot = the at-the-money option on that side over the same 15 minutes.
          </Text>
          {r.scorecard.map((x) => (
            <View key={x.key} style={s.row}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                <Text style={{ color: colors.text, fontWeight: '700', flexShrink: 1 }}>
                  {x.label}
                  {x.factor != null ? <Text style={{ color: colors.accent }}> · score factor</Text> : null}
                </Text>
                <Text style={{ color: hitColor(x.hitRate, x.enough), fontWeight: '800' }}>{pct(x.hitRate)}</Text>
              </View>
              <Text style={ui.muted}>
                {x.signals} signals · avg {x.avgPts == null ? '—' : sign(x.avgPts, 1)} pts · {x.perLot == null ? '₹ —' : `₹${sign(x.perLot)}/lot`} · caught{' '}
                {pct(x.caughtPct)} of moves{x.avgLead != null ? ` (${x.avgLead.toFixed(1)} candles early)` : ''}
                {x.best ? ` · best: ${x.best.label} ${pct(x.best.hitRate)}` : ''}
              </Text>
            </View>
          ))}
        </Card>
      ) : null}

      {r && r.agreement.length ? (
        <Card style={{ gap: 6 }}>
          <Text style={[ui.sectionTitle, { marginTop: 0 }]}>When indicators agree</Text>
          {r.agreement.map((a) => (
            <Text key={a.agree} style={s.line}>
              {a.agree} agree → moved that way <Text style={{ color: hitColor(a.hitRate, a.n >= MIN_SIGNALS), fontWeight: '700' }}>{pct(a.hitRate)}</Text>
              <Text style={ui.muted}> ({a.n} candles)</Text>
            </Text>
          ))}
        </Card>
      ) : null}

      {r && r.combos.length ? (
        <Card style={{ gap: 6 }}>
          <Text style={[ui.sectionTitle, { marginTop: 0 }]}>Best pairs</Text>
          {r.combos.map((c) => (
            <Text key={`${c.a}|${c.b}`} style={s.line}>
              {c.a.replace(/ \(.*\)$/, '')} + {c.b.replace(/ \(.*\)$/, '')} → <Text style={{ color: hitColor(c.hitRate, true), fontWeight: '700' }}>{pct(c.hitRate)}</Text>
              <Text style={ui.muted}> ({c.n})</Text>
            </Text>
          ))}
        </Card>
      ) : null}

      {r && r.records ? (
        <Card style={{ gap: 6 }}>
          <Text style={[ui.sectionTitle, { marginTop: 0 }]}>Suggested scoring weights</Text>
          {r.weights.ready ? (
            <>
              <Text style={ui.muted}>
                Learnt on {r.weights.trainDays} older days, tested on {r.weights.testDays} newer days ({r.weights.tested} candles): current weights{' '}
                {pct(r.weights.currentAcc, 1)} right, suggested {pct(r.weights.suggestedAcc, 1)}.
              </Text>
              <Text style={{ color: r.weights.better ? colors.up : colors.warn, fontWeight: '700' }}>
                {r.weights.better ? 'The suggested weights did better on the unseen days.' : 'Not clearly better yet — keep the current weights.'}
              </Text>
              {r.weights.factors.map((f) => (
                <Text key={f.key} style={s.line}>
                  {f.label}: {f.current} → <Text style={{ fontWeight: '700' }}>{f.suggested}</Text>
                  <Text style={ui.muted}> (hit {pct(f.trainHit)})</Text>
                </Text>
              ))}
              <Text style={ui.muted}>Suggestions only — the scoring engine is not changed. Ask for a change once you are happy with them.</Text>
            </>
          ) : (
            <Text style={ui.muted}>
              {r.weights.reason} Suggestions need at least {MIN_MOVES_FOR_WEIGHTS} marked moves and are tested on days they did not learn from.
            </Text>
          )}
        </Card>
      ) : null}

      {r && r.records ? (
        <Card style={{ gap: 8 }}>
          <Text style={[ui.sectionTitle, { marginTop: 0 }]}>Export (for the machine-learning engine)</Text>
          <Button label="Candles (CSV)" onPress={() => share(`market-memory-candles-${range}.csv`, recordsCsv(records), 'text/csv')} color={colors.cardAlt} />
          <Button label="Tops and bottoms (CSV)" onPress={() => share(`market-memory-moves-${range}.csv`, movesCsv(r.moves), 'text/csv')} color={colors.cardAlt} />
          <Button
            label="Everything (JSON)"
            onPress={() => share(`market-memory-${range}.json`, JSON.stringify({ records, moves: r.moves, scorecard: r.scorecard }), 'application/json')}
            color={colors.cardAlt}
          />
          <Text
            style={[ui.muted, { color: colors.down }]}
            onPress={() =>
              confirm('Delete Market Memory?', 'Every recorded day is deleted from this phone. Export first if you want to keep it.', 'Delete', () =>
                void marketMemory.clear().then(load, (e) => setMsg((e as Error).message)),
              )
            }
          >
            Delete all recorded days…
          </Text>
        </Card>
      ) : null}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  move: { gap: 3, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  line: { color: colors.text, fontSize: 13 },
  row: { gap: 2, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  chip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: colors.cardAlt },
  chipOn: { backgroundColor: colors.border },
});
