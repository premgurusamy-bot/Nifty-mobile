import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { Button, Card, Segmented, styles as ui } from '../../components/ui';
import { formatINR, formatNumber } from '../../lib/format';
import type { ScreenGroup, ScreenReport, ScreenResult, Verdict } from '../../lib/screener';
import { useEngine } from '../../state/EngineContext';
import { colors, pnlColor } from '../../theme';

const VERDICT: Record<Verdict, { color: string; text: string }> = {
  GOOD: { color: colors.up, text: 'GOOD NOW' },
  CAUTION: { color: colors.warn, text: 'CAUTION' },
  AVOID: { color: colors.down, text: 'AVOID' },
  'NO NEW TRADES': { color: colors.muted, text: 'NO NEW TRADES' },
};

const time = (ms: number) => new Date(ms + 5.5 * 3600_000).toISOString().slice(11, 16);

function IndexCard({ r, current, onUse }: { r: ScreenResult; current: boolean; onUse: () => void }) {
  const v = VERDICT[r.verdict];
  const p = r.plan;
  const sideWord =
    r.direction === 'CE' ? 'BUY CE (up)' : r.direction === 'PE' ? 'BUY PE (down)' : r.direction === 'LONG' ? 'BUY / long (up)' : 'SELL / short (down)';
  const fut = r.group === 'MCX';
  return (
    <Card style={{ gap: 10, borderColor: v.color, borderWidth: 1 }}>
      <View style={st.head}>
        <Text style={[ui.title, { fontSize: 20 }]}>{r.label}</Text>
        <Text style={[st.chip, { color: v.color, borderColor: v.color }]}>{v.text}</Text>
      </View>
      <View style={st.barTrack} accessibilityLabel={`Suitability ${r.score} of 100`}>
        <View style={[st.barFill, { width: `${r.score}%`, backgroundColor: v.color }]} />
      </View>
      <Text style={ui.muted}>
        Suitability {r.score}/100 · leaning {sideWord} · confidence {r.confidence.toFixed(1)} · {r.signal}
      </Text>
      <Text style={ui.title}>{r.summary}</Text>
      <Text style={ui.muted}>
        {formatNumber(r.spot)} · day {formatNumber(r.day.low)}–{formatNumber(r.day.high)}
        {r.day.avgRangePts ? ` (range ${Math.round(r.day.rangePts)} of ~${Math.round(r.day.avgRangePts)} pts normal)` : ''}
        {r.day.changePct != null ? ' · ' : ''}
        {r.day.changePct != null ? (
          <Text style={{ color: pnlColor(r.day.changePct) }}>
            {r.day.changePct >= 0 ? '+' : ''}
            {r.day.changePct.toFixed(2)}%
          </Text>
        ) : null}
      </Text>

      <View style={st.box}>
        <Text style={st.boxTitle}>If you ENTER at market now</Text>
        {p && !p.blocked && p.qty > 0 ? (
          <Text style={ui.title}>
            {fut
              ? `${p.direction === 'LONG' ? 'BUY' : 'SELL'} ${r.symbol} × ${p.qty} lot${p.qty === 1 ? '' : 's'}`
              : `BUY ${p.direction} ${p.strike}`}{' '}
            @ {formatNumber(p.entry)}
            {fut ? '' : ` × ${p.qty}`} · SL {formatNumber(p.sl)} · T1 {formatNumber(p.target1)} · max loss{' '}
            {formatINR(p.maxLoss, 0)}
          </Text>
        ) : (
          <Text style={{ color: colors.down }}>{p?.blocked ? `Refused: ${p.blocked}` : 'No price to plan with.'}</Text>
        )}
        <Text style={ui.muted}>{r.decision}</Text>
      </View>

      {r.pros.map((x) => (
        <Text key={x} style={[st.line, { color: colors.up }]}>
          ✓ {x}
        </Text>
      ))}
      {r.warnings.map((x) => (
        <Text key={x} style={[st.line, { color: colors.warn }]}>
          ⚠ {x}
        </Text>
      ))}
      {current ? (
        <Text style={ui.muted}>This is the index the engine is trading.</Text>
      ) : (
        <Button label={`Trade ${r.label} instead`} color={colors.cardAlt} onPress={onUse} />
      )}
    </Card>
  );
}

export default function ScreenerScreen() {
  const { snap, screener, updateConfig } = useEngine();
  const [group, setGroup] = useState<ScreenGroup>(snap?.config.instrumentKind === 'MCX_FUTURES' ? 'MCX' : 'INDEX');
  // One report per group, so switching back shows the last scan straight away.
  const [reports, setReports] = useState<Partial<Record<ScreenGroup, ScreenReport>>>({});
  const report = reports[group] ?? null;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const running = useRef(false);

  const scan = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setErr(null);
    try {
      const r = await screener(group);
      setReports((m) => ({ ...m, [r.group]: r }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [screener, group]);

  // First scan once the engine is ready; then every minute if you switch that on.
  const ready = !!snap;
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => void scan(), 0);
    return () => clearTimeout(t);
  }, [ready, scan]);
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => void scan(), 60_000);
    return () => clearInterval(t);
  }, [auto, scan]);

  const use = async (symbol: string) => {
    setErr(null);
    try {
      await updateConfig({ symbol });
      router.navigate('/');
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Segmented
        options={[
          { label: 'Indexes (NSE options)', value: 'INDEX' as ScreenGroup },
          { label: 'MCX minis', value: 'MCX' as ScreenGroup },
        ]}
        value={group}
        onChange={setGroup}
      />
      <Card style={{ gap: 8 }}>
        <View style={st.head}>
          <Text style={[ui.sectionTitle, { marginTop: 0 }]}>Market today</Text>
          {busy ? <ActivityIndicator color={colors.accent} /> : null}
        </View>
        {report ? (
          <>
            <Text style={ui.muted}>
              Scanned {time(report.at)} IST{snap?.demo ? ' · demo market' : ' · Dhan live data'}
            </Text>
            {report.notes.map((n) => (
              <Text key={n} style={st.line}>
                • {n}
              </Text>
            ))}
          </>
        ) : (
          <Text style={ui.muted}>
            {busy
              ? group === 'MCX'
                ? 'Scanning Gold, Silver, Crude Oil, Natural Gas, Lead, Zinc and Aluminium minis…'
                : 'Scanning NIFTY, BANK NIFTY and FIN NIFTY… (about 10 s)'
              : 'Not scanned yet.'}
          </Text>
        )}
        {err ? <Text style={{ color: colors.down }}>{err}</Text> : null}
        {report?.failed.map((f) => (
          <Text key={f.symbol} style={{ color: colors.down }}>
            {f.symbol}: {f.error}
          </Text>
        ))}
        <Button label={busy ? 'Scanning…' : 'Scan now'} onPress={() => void scan()} disabled={busy} />
        <View style={st.head}>
          <Text style={ui.muted}>Rescan every minute</Text>
          <Switch value={auto} onValueChange={setAuto} accessibilityLabel="Rescan every minute" />
        </View>
      </Card>

      {report?.results.map((r) => (
        <IndexCard key={r.symbol} r={r} current={snap?.config.symbol === r.symbol} onUse={() => void use(r.symbol)} />
      ))}

      <Text style={[ui.muted, { fontSize: 12 }]}>
        Best first. The score uses the engine&apos;s own confidence plus how cleanly the market is moving, whether the
        trend agrees, volatility, and whether ENTER would be allowed under your settings (sizing, premium filters,
        cutoff). It reads prices, OI and IV only — not news. It guides; it does not guarantee a result.
      </Text>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  chip: { fontWeight: '800', fontSize: 12, letterSpacing: 0.5, borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  barTrack: { height: 6, borderRadius: 3, backgroundColor: colors.cardAlt, overflow: 'hidden' },
  barFill: { height: 6, borderRadius: 3 },
  box: { backgroundColor: colors.cardAlt, borderRadius: 10, padding: 10, gap: 4 },
  boxTitle: { color: colors.muted, fontSize: 12, fontWeight: '600', letterSpacing: 0.3 },
  line: { color: colors.text, fontSize: 13 },
});
