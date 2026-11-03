import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  Breakdown,
  ConfidenceMeter,
  KV,
  PreflightList,
  signalColor,
  type PreflightView,
} from '../../components/engine';
import { LineChart } from '../../components/LineChart';
import { Button, Card, Empty, Segmented, styles as ui } from '../../components/ui';
import type { TradeMode } from '../../lib/engine/types';
import { formatINR, formatNumber, formatSigned } from '../../lib/format';
import { useEngine } from '../../state/EngineContext';
import { colors, pnlColor } from '../../theme';

/** Yes/No confirmation that works on Android and in the web build. */
const confirmDialog = (title: string, msg: string, yes: string, onYes: () => void) => {
  if (Platform.OS === 'web') {
    if (globalThis.confirm?.(`${title}\n\n${msg}`)) onYes();
    return;
  }
  Alert.alert(title, msg, [
    { text: 'Cancel', style: 'cancel' },
    { text: yes, style: 'destructive', onPress: onYes },
  ]);
};

const time = (ms: number | null) => {
  if (!ms) return '—';
  const d = new Date(ms + 5.5 * 3600_000);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)} IST`;
};

export default function DashboardScreen() {
  const { snap, busy, error, refresh, updateConfig, mode, phone, enter, cancelEntry, exit, setTradeMode } = useEngine();
  const [priceText, setPriceText] = useState('');
  const [toggling, setToggling] = useState(false);
  const [modeBusy, setModeBusy] = useState(false);
  const [blocked, setBlocked] = useState<PreflightView | null>(null);
  const [tradeMsg, setTradeMsg] = useState<string | null>(null);

  if (!snap) {
    return (
      <View
        style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: 24 }}
      >
        {error ? <Empty title="Cannot load the engine" hint={error} /> : <ActivityIndicator color={colors.accent} />}
      </View>
    );
  }

  const { dashboard: d, config: cfg, state: st } = snap;
  const toggleAuto = async (v: boolean) => {
    setToggling(true);
    await updateConfig({ autoRefresh: v }).catch(() => {});
    setToggling(false);
  };
  const p = st.position;
  const ltp = d?.positionLtp ?? null;
  const isLive = cfg.tradeMode === 'LIVE';
  const cand = d?.candidatePlan ?? null;

  const switchMode = (m: TradeMode) => {
    if (m === cfg.tradeMode) return;
    setBlocked(null);
    setTradeMsg(null);
    const go = async () => {
      setModeBusy(true);
      try {
        const pf = await setTradeMode(m);
        if (pf && !pf.ok) setBlocked(pf);
      } catch (e) {
        setTradeMsg((e as Error).message);
      } finally {
        setModeBusy(false);
      }
    };
    if (m === 'LIVE') {
      confirmDialog(
        'Switch to LIVE trading?',
        'A pre-flight check runs first. In LIVE mode the ENTER and EXIT buttons place REAL orders on your Dhan account, and every entry gets a stop-loss order at Dhan. Signals are never traded automatically.',
        'Run check & go LIVE',
        () => void go(),
      );
    } else void go();
  };

  // Editable buy price: blank = market; a price below the premium waits as a limit order.
  const limit = priceText.trim() ? Number(priceText) : null;
  const limitValid =
    limit == null || (Number.isFinite(limit) && limit > 0 && Math.abs(Math.round(limit * 20) / 20 - limit) < 1e-9);
  const atPrice = limit ?? cand?.entry ?? 0;
  const shift = cand ? atPrice - cand.entry : 0; // SL/targets keep their distance from the entry
  const lots = (q: number) => (cfg.lotSize > 0 ? q / cfg.lotSize : 0);
  const qtyLabel = (q: number) => `${q} (${lots(q)} lot${lots(q) === 1 ? '' : 's'})`;
  const pe = st.pendingEntry;

  const doEnter = () => {
    if (!cand) return;
    if (!limitValid) return setTradeMsg('Buy price must be a positive number in steps of 0.05 (e.g. 110.05)');
    const how =
      limit == null
        ? `at market (~${formatNumber(cand.entry)})`
        : `limit @ ${formatNumber(limit)}${limit < cand.entry ? ` — waits until the premium comes down (now ${formatNumber(cand.entry)})` : ''}`;
    const what = `BUY ${cand.direction} ${cand.strike} × ${qtyLabel(cand.qty)} ${how}\nSL ${formatNumber(cand.sl + shift)} · T1 ${formatNumber(cand.target1 + shift)} · T2 ${formatNumber(cand.target2 + shift)} · max loss ${formatINR(cand.maxLoss, 0)}`;
    const go = () => {
      setTradeMsg(null);
      enter(limit ?? undefined)
        .then(() => setPriceText(''))
        .catch((e) => setTradeMsg((e as Error).message));
    };
    if (isLive)
      confirmDialog(
        'Place LIVE order?',
        `${what}\n\nA stop-loss sell order is placed at Dhan right after the fill.`,
        'Buy now',
        go,
      );
    else confirmDialog('Paper entry', what, 'Enter (paper)', go);
  };

  const doExit = () => {
    if (!p) return;
    const what = `Sell ${p.remainingQty} ${p.direction} ${p.strike} at market${ltp ? ` (~${formatNumber(ltp)})` : ''}`;
    const go = () => {
      setTradeMsg(null);
      exit().catch((e) => setTradeMsg((e as Error).message));
    };
    if (isLive)
      confirmDialog('Exit LIVE position?', `${what}\nThe stop-loss order at Dhan is cancelled first.`, 'Exit now', go);
    else confirmDialog('Exit paper position?', what, 'Exit', go);
  };
  const openPnl = p && ltp ? (ltp - p.entry) * p.remainingQty + p.partialPnl : null;

  return (
    <ScrollView
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: 16, gap: 12 }}
      refreshControl={
        <RefreshControl refreshing={busy} onRefresh={() => refresh().catch(() => {})} tintColor={colors.accent} />
      }
    >
      {/* Header: Last refresh / Status / Refresh Now / Auto refresh */}
      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text style={[ui.title, { fontSize: 18 }]}>{cfg.symbol} OPTION BUYING</Text>
          <Text style={ui.muted}>
            {snap.demo ? 'DEMO · accelerated simulation · ' : 'Dhan live · '}
            {snap.marketOpen ? 'market open' : 'market closed'}
          </Text>
          <Text style={ui.muted}>Last refresh: {time(snap.lastRefresh)}</Text>
          <Text style={[ui.muted, { color: snap.status.startsWith('Error') ? colors.down : colors.muted }]}>
            Status: {snap.status}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end', gap: 6 }}>
          <Text style={ui.muted}>Auto refresh</Text>
          <Switch value={cfg.autoRefresh} disabled={toggling} onValueChange={toggleAuto} />
        </View>
      </View>
      {/* Trade mode: PAPER (engine paper-trades) / LIVE (real Dhan orders via ENTER/EXIT) */}
      <Card
        style={{
          gap: 10,
          borderColor: isLive ? colors.down : colors.border,
          borderWidth: isLive ? 1 : StyleSheet.hairlineWidth,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={[ui.sectionTitle, { marginTop: 0 }]}>Trading mode</Text>
          {modeBusy ? <ActivityIndicator color={colors.accent} /> : null}
        </View>
        <Segmented
          options={[
            { label: 'PAPER', value: 'PAPER' as TradeMode },
            { label: 'LIVE', value: 'LIVE' as TradeMode },
          ]}
          value={cfg.tradeMode}
          onChange={(m) =>
            phone ? switchMode(m) : setTradeMsg('Connect your Dhan account in ⚙ Settings to trade LIVE.')
          }
        />
        <Text style={[ui.muted, isLive && { color: colors.down, fontWeight: '700' }]}>
          {isLive
            ? 'LIVE — ENTER / EXIT place real orders on your Dhan account. Signals are not traded automatically.'
            : 'PAPER — signals are traded on paper, nothing is sent to Dhan.'}
        </Text>
        {blocked ? <PreflightList result={blocked} /> : null}
      </Card>
      {snap.banner ? <Text style={s.banner}>{snap.banner}</Text> : null}
      {error ? <Text style={s.banner}>{error}</Text> : null}
      <Button
        label={busy ? 'Refreshing…' : snap.demo ? 'Refresh now (next 5-min candle)' : 'Refresh now'}
        onPress={() => refresh().catch(() => {})}
        disabled={busy}
      />

      {!d ? (
        <Empty
          title="No data yet"
          hint="Tap Refresh now. Outside market hours Dhan still returns the last session's data."
        />
      ) : (
        <>
          {/* SIGNAL */}
          <Card style={{ gap: 10, borderColor: signalColor(d.decision.signal), borderWidth: 1 }}>
            <Text style={ui.muted}>SIGNAL</Text>
            <Text style={[s.signal, { color: signalColor(d.decision.signal) }]}>{d.decision.signal}</Text>
            <Text style={ui.title}>{d.decision.decisionText}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
              <Text style={[ui.h1, { fontSize: 24 }]}>{formatNumber(d.decision.confidence, 1)}</Text>
              <Text style={ui.muted}>
                / 100 confidence · {d.decision.direction} {d.decision.selectedStrike}
              </Text>
            </View>
            <ConfidenceMeter value={d.decision.confidence} watch={cfg.confWatch} high={cfg.confHigh} />
            <Text style={ui.muted}>
              CE score {formatNumber(d.decision.scoreCE, 1)} · PE score {formatNumber(d.decision.scorePE, 1)} · pattern{' '}
              {d.decision.pattern}
            </Text>
          </Card>

          {/* Manual entry / exit */}
          <Card style={{ gap: 10 }}>
            <Text style={[ui.sectionTitle, { marginTop: 0 }]}>Manual {isLive ? 'LIVE' : 'paper'} trade</Text>
            {pe ? (
              <>
                <Text style={ui.title}>
                  Entry order pending: BUY {pe.plan.direction} {pe.plan.strike} × {qtyLabel(pe.plan.qty)} @ ≤{' '}
                  {formatNumber(pe.limit)}
                </Text>
                <Text style={ui.muted}>
                  {pe.live
                    ? `Limit order ${pe.live.orderId} is waiting at Dhan. `
                    : 'Fills when the premium comes down to your price. '}
                  Checked on every refresh — turn on Auto refresh to follow it.
                </Text>
                <Button
                  label={busy ? 'Working…' : 'Cancel entry order'}
                  color={colors.cardAlt}
                  onPress={() => {
                    setTradeMsg(null);
                    cancelEntry().catch((e) => setTradeMsg((e as Error).message));
                  }}
                  disabled={busy}
                />
              </>
            ) : p ? (
              <Button
                label={
                  busy ? 'Working…' : `EXIT ${p.direction} ${p.strike} × ${p.remainingQty}${isLive ? ' (LIVE)' : ''}`
                }
                color={colors.down}
                onPress={doExit}
                disabled={busy}
              />
            ) : cand ? (
              <>
                <Text style={ui.muted}>
                  Premium now {formatNumber(cand.entry)} · quantity {qtyLabel(cand.qty)}
                </Text>
                <View style={{ gap: 6 }}>
                  <Text style={s.label}>Buy price (blank = market)</Text>
                  <TextInput
                    style={[s.input, !limitValid && { borderColor: colors.down }]}
                    value={priceText}
                    onChangeText={(t) => {
                      setPriceText(t.replace(/[^\d.]/g, ''));
                      setTradeMsg(null);
                    }}
                    placeholder={`Market (~${formatNumber(cand.entry)})`}
                    placeholderTextColor={colors.muted}
                    keyboardType="decimal-pad"
                  />
                </View>
                <Text style={ui.muted}>
                  At {limit == null ? 'market' : formatNumber(atPrice)}: SL {formatNumber(cand.sl + shift)} · T1{' '}
                  {formatNumber(cand.target1 + shift)} · T2 {formatNumber(cand.target2 + shift)} · max loss{' '}
                  {formatINR(cand.maxLoss, 0)}. Daily limits still apply.
                </Text>
                <Button
                  label={
                    busy
                      ? 'Working…'
                      : `ENTER BUY ${cand.direction} ${cand.strike} × ${cand.qty} ${limit == null ? '@ market' : `@ ${formatNumber(limit)}`}${isLive ? ' (LIVE)' : ''}`
                  }
                  color={cand.direction === 'CE' ? colors.up : colors.down}
                  onPress={doEnter}
                  disabled={busy}
                />
              </>
            ) : (
              <Text style={ui.muted}>No strike available to enter yet.</Text>
            )}
            {tradeMsg ? <Text style={{ color: colors.down, fontWeight: '600' }}>{tradeMsg}</Text> : null}
          </Card>

          {p ? (
            <KV
              title={`Open position · ${p.direction} ${p.strike}`}
              rows={[
                ['Entry', p.entry],
                ['Live premium', ltp ?? '—'],
                ['Current (trailing) SL', p.currentSl, colors.down],
                ['Target 1', p.target1, colors.up],
                ['Target 2', p.target2, colors.up],
                ['Quantity (remaining / total)', `${p.remainingQty} / ${p.totalQty}`],
                ['Partial booked', p.partialBooked ? `${p.partialQty} @ T1 (${formatSigned(p.partialPnl, 0)})` : 'No'],
                [
                  'Open P&L (incl. booked)',
                  openPnl == null ? '—' : formatSigned(openPnl, 0),
                  openPnl == null ? undefined : pnlColor(openPnl),
                ],
              ]}
            />
          ) : d.plan ? (
            <KV
              title="Trade plan"
              rows={[
                ['Selected strike', `${d.plan.strike} ${d.plan.direction}`],
                ['Entry', d.plan.entry],
                ['Stop loss', d.plan.sl, colors.down],
                ['Target 1', d.plan.target1, colors.up],
                ['Target 2', d.plan.target2, colors.up],
                ['Risk (pts)', d.plan.riskPts],
                ['Reward (pts)', d.plan.rewardPts],
                ['Risk:Reward', d.plan.rr],
                ['Quantity', String(d.plan.qty)],
                ['Max loss', formatINR(d.plan.maxLoss, 0)],
                ['Potential profit (T1)', formatINR(d.plan.potentialProfit, 0)],
              ]}
            />
          ) : null}

          <Card style={{ gap: 8 }}>
            <Text style={[ui.sectionTitle, { marginTop: 0 }]}>{cfg.symbol} · 5-min</Text>
            <LineChart data={snap.closes} height={140} />
          </Card>

          <KV
            title="Decision engine"
            rows={[
              ['Market sentiment', d.decision.sentiment],
              ['Market trend', d.decision.trend],
              ['OI strength', d.decision.oiStrength],
              [
                'IV percentile',
                d.decision.ivPercentile < 0
                  ? `building history (${st.ivSnapshots}/20)`
                  : `${formatNumber(d.decision.ivPercentile, 0)}%`,
              ],
            ]}
          />
          <KV
            title="Market"
            rows={[
              [`${cfg.symbol} spot`, d.market.spot],
              ['ATM strike', String(d.market.atm)],
              ['Trend', d.market.trend],
              ['VWAP', d.market.vwap],
              ['EMA20', d.market.ema20],
              ['EMA50', d.market.ema50],
              ['ATR', d.market.atr],
            ]}
          />
          <KV
            title={`Option chain · expiry ${d.expiry || '—'}`}
            rows={[
              ['CE LTP', d.chain.ceLtp],
              ['PE LTP', d.chain.peLtp],
              ['CE OI', formatNumber(d.chain.ceOi, 0)],
              ['PE OI', formatNumber(d.chain.peOi, 0)],
              ['Change in OI', formatNumber(d.chain.changeInOi, 0)],
              ['PCR', formatNumber(d.chain.pcr, 3)],
              ['Max pain', String(d.chain.maxPain)],
              ['Support (max PE OI)', String(d.chain.support)],
              ['Resistance (max CE OI)', String(d.chain.resistance)],
              ['Price swing support', d.chain.swingSupport],
              ['Price swing resistance', d.chain.swingResistance],
            ]}
          />
          <KV
            title={`Greeks · ${d.decision.direction} ${d.decision.selectedStrike}`}
            rows={[
              ['Delta', formatNumber(d.greeks.delta, 4)],
              ['Gamma', formatNumber(d.greeks.gamma, 5)],
              ['Theta', formatNumber(d.greeks.theta, 2)],
              ['Vega', formatNumber(d.greeks.vega, 2)],
              ['IV', formatNumber(d.greeks.iv, 2)],
            ]}
          />
          <Breakdown b={d.breakdown} total={d.decision.confidence} />
        </>
      )}

      <KV
        title="Daily discipline"
        rows={[
          ['Trades today', `${st.tradesToday} / ${cfg.maxTradesPerDay}`],
          ['Realized P&L today', formatSigned(st.realizedToday, 0), pnlColor(st.realizedToday)],
          ['Daily max loss', cfg.maxDailyLoss ? formatINR(cfg.maxDailyLoss, 0) : 'No limit'],
          [
            'Pending setup',
            st.pending
              ? `${st.pending.direction} ${st.pending.strike} · break ${formatNumber(st.pending.trigger)}`
              : '—',
          ],
          ['Blocked reason', st.blockedReason || '—'],
        ]}
      />

      {st.events.length ? (
        <Card style={{ gap: 6 }}>
          <Text style={[ui.sectionTitle, { marginTop: 0 }]}>Alerts</Text>
          {st.events.slice(0, 8).map((e, i) => (
            <Text
              key={i}
              style={{
                color: e.kind === 'EXIT' ? colors.text : e.kind === 'TRADE' ? colors.up : colors.warn,
                fontSize: 13,
              }}
            >
              {time(e.at).slice(11, 19)} · {e.message}
            </Text>
          ))}
        </Card>
      ) : null}

      <Text style={[ui.muted, { textAlign: 'center', fontSize: 12, marginBottom: 12 }]}>
        Decision-support only — no orders are placed automatically. Confidence and R:R are a filter, not a prediction.
        {mode === 'DEMO' ? ' Demo data is simulated.' : ''}
      </Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', gap: 12 },
  signal: { fontSize: 34, fontWeight: '800', letterSpacing: 0.5 },
  banner: { color: '#fff', backgroundColor: '#7F1D1D', padding: 10, borderRadius: 10, fontWeight: '600' },
  label: { color: colors.muted, fontSize: 12 },
  input: {
    backgroundColor: colors.cardAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    fontSize: 18,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontVariant: ['tabular-nums'],
  },
});
