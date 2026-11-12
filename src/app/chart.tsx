/**
 * Chart: the selected index's 5-minute candles with the app's indicators, today's entries / exits
 * and Market Memory's tops and bottoms — plus the Pine Script (TradingView) versions of the app's
 * indicators and strategy, made from your current settings.
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { CandleChart, type ChartMarker } from '../components/CandleChart';
import { Button, Card, Empty, Segmented, styles as ui } from '../components/ui';
import type { Candle } from '../lib/engine/types';
import { analyse } from '../lib/memory/analysis';
import { marketMemory } from '../lib/memory/fileStore';
import { istDay } from '../lib/memory/recorder';
import { pineScore, pineStrategy } from '../lib/pine';
import { shareTextFile } from '../lib/shareFile';
import { useEngine } from '../state/EngineContext';
import { colors } from '../theme';

type Span = '40' | '75' | '150';
const istMs = (date: string, time: string) => Date.parse(`${date}T${time.length === 5 ? `${time}:00` : time}+05:30`);

export default function ChartScreen() {
  const { snap } = useEngine();
  const [span, setSpan] = useState<Span>('75');
  const [moves, setMoves] = useState<ChartMarker[]>([]);
  const [msg, setMsg] = useState('');
  const cfg = snap?.config;
  const candles = (snap as { candles?: Candle[] } | null)?.candles ?? [];
  const symbol = cfg?.symbol ?? 'NIFTY';
  const last = candles.at(-1);
  const today = last ? istDay(last.t) : '';

  // Market Memory's tops and bottoms for this index today.
  useFocusEffect(
    useCallback(() => {
      if (!today) return;
      let alive = true;
      marketMemory
        .load([today])
        .then((recs) => {
          if (!alive) return;
          const rep = analyse(recs, { confHigh: cfg?.confHigh ?? 80, symbol });
          setMoves(
            rep.moves.flatMap((m): ChartMarker[] => [
              { t: m.start.t, price: m.start.price, kind: m.dir === 'UP' ? 'BOTTOM' : 'TOP' },
              ...(m.open ? [] : [{ t: m.end.t, price: m.end.price, kind: (m.dir === 'UP' ? 'TOP' : 'BOTTOM') as ChartMarker['kind'] }]),
            ]),
          );
        })
        .catch(() => {});
      return () => {
        alive = false;
      };
    }, [today, symbol, cfg?.confHigh]),
  );

  if (!snap || !cfg) return <Empty title="No data yet" hint="Open the Dashboard and refresh first." />;

  // The app's own trades on this index today (entry at the index price then; exit at that candle's close).
  const closeAt = (t: number) => {
    let c: number | null = null;
    for (const k of candles) if (k.t <= t) c = k.c;
    return c;
  };
  const trades: ChartMarker[] = snap.state.journal
    .filter((j) => j.date === today && (j.symbol ?? 'NIFTY') === symbol)
    .flatMap((j): ChartMarker[] => {
      const out: ChartMarker[] = [];
      const t = istMs(j.date, j.time);
      if (j.spot > 0) out.push({ t, price: j.spot, kind: j.direction === 'PE' || j.direction === 'SHORT' ? 'BUY_PE' : 'BUY_CE' });
      const exitTime = (j as { exitTime?: string }).exitTime;
      if (j.exit != null && exitTime) {
        const te = istMs(j.date, exitTime);
        const p = closeAt(te);
        if (p) out.push({ t: te, price: p, kind: 'EXIT' });
      }
      return out;
    });
  const pending = snap.state.pending;
  const level = pending && pending.trigger > 0 ? { price: pending.trigger, label: `${pending.direction} setup: break of ${pending.trigger.toFixed(1)}` } : null;

  const share = (name: string, text: string) => {
    setMsg('');
    shareTextFile(name, text, 'text/plain').catch((e) => setMsg((e as Error).message));
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Card style={{ gap: 10 }}>
        <Text style={[ui.sectionTitle, { marginTop: 0 }]}>{symbol} · 5-minute candles</Text>
        <Segmented
          options={[
            { label: '40', value: '40' as Span },
            { label: '75 (a day)', value: '75' as Span },
            { label: '150', value: '150' as Span },
          ]}
          value={span}
          onChange={setSpan}
        />
        {candles.length ? (
          <CandleChart candles={candles} show={Number(span)} markers={[...moves, ...trades]} level={level} />
        ) : (
          <Text style={ui.muted}>No candles yet — refresh on the Dashboard (multi-index: the chart follows the index selected there).</Text>
        )}
      </Card>

      <Card style={{ gap: 8 }}>
        <Text style={[ui.sectionTitle, { marginTop: 0 }]}>Pine Script for TradingView</Text>
        <Text style={ui.muted}>
          The app&apos;s indicators and strategy as TradingView Pine Script (v5), made from your current settings (lots, stop, RR, trade level,
          entry cutoff, max trades, gap guard, profit lock).
        </Text>
        <Button label="Strategy (.pine)" onPress={() => share(`nifty-trader-strategy-${symbol}.pine`, pineStrategy(cfg))} />
        <Button label="Score panel (.pine)" onPress={() => share('nifty-trader-score.pine', pineScore(cfg))} color={colors.cardAlt} />
        <View style={{ gap: 2 }}>
          <Text style={ui.muted}>1. Open TradingView → a 5-minute {symbol} chart → Pine Editor.</Text>
          <Text style={ui.muted}>2. Paste the file&apos;s text, Save, then &quot;Add to chart&quot;. The Strategy Tester shows the backtest.</Text>
          <Text style={ui.muted}>
            TradingView sees only price and volume: PCR, OI, delta, IV, gamma and theta (the option-chain part of the app&apos;s score)
            can&apos;t be used there, so its score and trades can differ from the app&apos;s. P&amp;L is an option estimate (index points ×
            delta × quantity).
          </Text>
        </View>
        {msg ? <Text style={{ color: colors.down }}>{msg}</Text> : null}
      </Card>
    </ScrollView>
  );
}
