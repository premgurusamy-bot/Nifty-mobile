import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  FactorBreakdown,
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
import { LivePnlCard } from '../../components/LivePnl';
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

/** Lots per trade: − / + (Fixed lots). From another sizing mode the first tap switches to Fixed lots. */
function LotStepper(p: {
  lots: number;
  fixed: boolean;
  max: number;
  unitsPerLot: number;
  /** Lots the next entry will really take (fewer when the capital can't pay for all of them). */
  planLots: number;
  cost: number | null;
  maxLoss: number | null;
  onChange: (lots: number) => void;
}) {
  const set = (n: number) => p.onChange(Math.min(p.max, Math.max(1, n)));
  return (
    <View style={{ gap: 4 }}>
      <View style={s.stepRow}>
        <Text style={s.label}>Lots per trade</Text>
        <View style={s.stepRow}>
          <Pressable
            onPress={() => set(p.lots - 1)}
            disabled={p.fixed && p.lots <= 1}
            accessibilityRole="button"
            accessibilityLabel="Fewer lots"
            style={[s.stepBtn, p.fixed && p.lots <= 1 && { opacity: 0.4 }]}
          >
            <Text style={s.stepTxt}>−</Text>
          </Pressable>
          <Text style={s.stepVal} accessibilityLabel={`${p.lots} lots`}>
            {p.lots}
          </Text>
          <Pressable
            onPress={() => set(p.lots + 1)}
            disabled={p.fixed && p.lots >= p.max}
            accessibilityRole="button"
            accessibilityLabel="More lots"
            style={[s.stepBtn, p.fixed && p.lots >= p.max && { opacity: 0.4 }]}
          >
            <Text style={s.stepTxt}>+</Text>
          </Pressable>
        </View>
      </View>
      {p.fixed && p.planLots > 0 && p.planLots < p.lots ? (
        <Text style={{ color: colors.warn, fontSize: 12, fontWeight: '600' }}>
          Capital pays for {p.planLots} of {p.lots} lots at this premium — the entry takes {p.planLots}
        </Text>
      ) : null}
      <Text style={[ui.muted, { fontSize: 12 }]}>
        {(p.fixed && p.planLots > 0 ? Math.min(p.planLots, p.lots) : p.lots) * p.unitsPerLot} qty
        {p.cost ? ` · needs ~${formatINR(p.cost, 0)}` : ''}
        {p.maxLoss ? ` · max loss ${formatINR(p.maxLoss, 0)}` : ''}
        {p.fixed ? ` · max ${p.max} lots` : ' · tap − / + to use fixed lots'}
      </Text>
    </View>
  );
}

export default function DashboardScreen() {
  const { snap, busy, error, refresh, updateConfig, mode, phone, enter, cancelEntry, exit, setTradeMode, setActive } = useEngine();
  // null = follow the market premium; a string = the price you typed.
  const [priceEdit, setPriceText] = useState<string | null>(null);
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
  // The box shows the live premium until you edit it. Unchanged (or emptied) → market order;
  // a different price → limit order at that price.
  const isFut = cfg.instrumentKind === 'MCX_FUTURES';
  const tick = cfg.tickSize || 0.05;
  const dp = tick >= 1 ? 0 : 2;
  const contract = cfg.futTradingSymbol || cfg.symbol;
  const sideOfDir = (dir: string) => (dir === 'SHORT' ? -1 : 1);
  /** "BUY PE 24200" (options) / "BUY GOLDM DEC FUT" or "SELL …" (futures). */
  const tradeLabel = (dir: string, strike: number) =>
    dir === 'LONG' || dir === 'SHORT' ? `${dir === 'LONG' ? 'BUY' : 'SELL'} ${contract}` : `BUY ${dir} ${strike}`;
  const marketText = cand ? cand.entry.toFixed(dp) : '';
  const priceText = priceEdit ?? marketText;
  const edited = priceEdit != null && priceEdit.trim() !== '' && cand != null && Number(priceEdit) !== cand.entry;
  const limit = edited ? Number(priceEdit) : null;
  const limitValid =
    limit == null || (Number.isFinite(limit) && limit > 0 && Math.abs(Math.round(limit / tick) * tick - limit) < 1e-6);
  const atPrice = limit ?? cand?.entry ?? 0;
  const shift = cand ? atPrice - cand.entry : 0; // SL/targets keep their distance from the entry
  const lots = (q: number) => (cfg.lotSize > 0 ? q / cfg.lotSize : 0);
  // MCX quantities are lots already; option quantities are units.
  const qtyLabel = (q: number) =>
    isFut ? `${q} lot${q === 1 ? '' : 's'}` : `${q} (${lots(q)} lot${lots(q) === 1 ? '' : 's'})`;
  const pe = st.pendingEntry;

  const doEnter = () => {
    if (!cand) return;
    if (!limitValid) return setTradeMsg(`Price must be a positive number in steps of ${tick}`);
    const side = sideOfDir(cand.direction);
    const waits = limit != null && side * (cand.entry - limit) > 0;
    const how =
      limit == null
        ? `at market (~${formatNumber(cand.entry, dp)})`
        : `limit @ ${formatNumber(limit, dp)}${waits ? ` — waits until the price ${side > 0 ? 'comes down' : 'rises'} to it (now ${formatNumber(cand.entry, dp)})` : ''}`;
    const what = `${tradeLabel(cand.direction, cand.strike)} × ${qtyLabel(cand.qty)} ${how}\nSL ${formatNumber(cand.sl + shift)} · T1 ${formatNumber(cand.target1 + shift)} · T2 ${formatNumber(cand.target2 + shift)} · max loss ${formatINR(cand.maxLoss, 0)}`;
    const go = () => {
      setTradeMsg(null);
      enter(limit ?? undefined)
        .then(() => setPriceText(null))
        .catch((e) => setTradeMsg((e as Error).message));
    };
    if (isLive)
      confirmDialog(
        'Place LIVE order?',
        `${what}\n\nA stop-loss order is placed at Dhan right after the fill.`,
        side > 0 ? 'Buy now' : 'Sell now',
        go,
      );
    else confirmDialog('Paper entry', what, 'Enter (paper)', go);
  };

  const doExit = () => {
    if (!p) return;
    const closing = (p.side ?? 1) > 0 ? 'Sell' : 'Buy back';
    const what = `${closing} ${qtyLabel(p.remainingQty)} ${p.direction === 'LONG' || p.direction === 'SHORT' ? contract : `${p.direction} ${p.strike}`} at market${ltp ? ` (~${formatNumber(ltp, dp)})` : ''}`;
    const go = () => {
      setTradeMsg(null);
      exit().catch((e) => setTradeMsg((e as Error).message));
    };
    if (isLive)
      confirmDialog('Exit LIVE position?', `${what}\nThe stop-loss order at Dhan is cancelled first.`, 'Exit now', go);
    else confirmDialog('Exit paper position?', what, 'Exit', go);
  };
  // Running P&L uses the fast quote when there is one (falls back to the last refresh).
  const liveLtp = snap?.live?.ltp ?? ltp;
  const openPnl =
    snap?.live?.tradePnl ??
    (p && ltp ? (p.side ?? 1) * (ltp - p.entry) * p.remainingQty * (p.pointValue ?? 1) + p.partialPnl : null);

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
          <Text style={[ui.title, { fontSize: 18 }]}>
            {cfg.symbol} {isFut ? 'FUTURES (MCX)' : 'OPTION BUYING'}
          </Text>
          <Text style={ui.muted}>
            {snap.demo
              ? 'DEMO · accelerated simulation · '
              : snap.feeds?.[cfg.symbol]?.feed === 'ANGEL'
                ? 'Angel One data · Dhan orders · '
                : 'Dhan live · '}
            {snap.marketOpen ? 'market open' : 'market closed'}
          </Text>
          <Text style={ui.muted}>
            Last refresh: {time(snap.lastRefresh)}
            {snap.lastTick ? ` · live quotes ${time(snap.lastTick)}` : ''}
          </Text>
          {snap.balances && Object.keys(snap.balances).length ? (
            <Text style={ui.muted}>
              Balance:{' '}
              {(['DHAN', 'ANGEL'] as const)
                .filter((b) => snap.balances?.[b])
                .map((b) => `${b === 'ANGEL' ? 'Angel One' : 'Dhan'} ${formatINR(snap.balances![b]!.amount, 0)}`)
                .join(' · ')}
            </Text>
          ) : null}
          <Text style={[ui.muted, { color: snap.status.startsWith('Error') ? colors.down : colors.muted }]}>
            Status: {snap.status}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end', gap: 6 }}>
          <Text style={ui.muted}>Auto refresh</Text>
          <Switch value={cfg.autoRefresh} disabled={toggling} onValueChange={toggleAuto} />
        </View>
      </View>
      {snap.watch ? (
        <Card style={{ gap: 8 }}>
          <Text style={[ui.sectionTitle, { marginTop: 0 }]}>Watching {snap.watch.length} indexes</Text>
          {snap.watch.map((w) => (
            <Pressable
              key={w.symbol}
              onPress={() => (w.active ? undefined : void setActive(w.symbol).catch((e) => setTradeMsg((e as Error).message)))}
              accessibilityRole="button"
              accessibilityLabel={`${w.label} ${w.confidence ?? ''}`}
              style={[s.watchRow, w.active && { borderColor: colors.accent }]}
            >
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Text style={ui.title}>
                  {w.label}
                  {w.inTrade ? '  · IN TRADE' : w.pendingEntry ? '  · ORDER PENDING' : w.paused ? '  · PAUSED' : ''}
                  {w.active ? '  · shown below' : ''}
                </Text>
                {snap.feeds?.[w.symbol] && (snap.feeds[w.symbol].feed === 'ANGEL' || snap.feeds[w.symbol].note) ? (
                  <Text style={{ fontSize: 11, color: snap.feeds[w.symbol].feed === 'ANGEL' ? colors.accent : colors.down }}>
                    {snap.feeds[w.symbol].feed === 'ANGEL' ? 'Data: Angel One' : snap.feeds[w.symbol].note}
                  </Text>
                ) : null}
                {w.trade ? (
                  <Text style={{ fontWeight: '700', color: w.trade.pnl == null ? colors.muted : pnlColor(w.trade.pnl) }}>
                    {w.trade.label} × {w.trade.qty} @ {formatNumber(w.trade.entry)}
                    {w.trade.pnl == null ? '' : `  ${w.trade.pnl >= 0 ? '+' : '−'}${formatINR(Math.abs(w.trade.pnl), 0)}`}
                  </Text>
                ) : null}
                <Text style={[ui.muted, { fontSize: 12 }]} numberOfLines={2}>
                  {w.error ? `Error: ${w.error}` : w.decision}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={[s.watchScore, { color: signalColor(w.signal as never) }]}>
                  {w.confidence == null ? '—' : w.confidence.toFixed(1)}
                </Text>
                <Text style={[ui.muted, { fontSize: 11 }]}>
                  {w.direction} {w.strike || ''}
                </Text>
              </View>
            </Pressable>
          ))}
          <Text style={[ui.muted, { fontSize: 11 }]}>Tap an index to see its details and ENTER / EXIT on it. Each index can be in its own trade.</Text>
        </Card>
      ) : null}
      {snap.live ? (
        <LivePnlCard
          live={snap.live}
          position={p ?? null}
          demo={snap.demo}
          profitLock={cfg.profitLock || cfg.dayPlanLock}
          label={p ? (p.direction === 'LONG' || p.direction === 'SHORT' ? `${p.direction} ${contract}` : `${p.direction} ${p.strike}`) : ''}
        />
      ) : null}
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
        <Text style={s.label}>Entries</Text>
        <Segmented
          options={[
            { label: 'Manual (tap ENTER)', value: 'MANUAL' as const },
            { label: 'Automatic', value: 'AUTO' as const },
          ]}
          value={(isLive ? cfg.autoEntryLive : cfg.autoEntryPaper !== false) ? 'AUTO' : 'MANUAL'}
          onChange={(v) => {
            const on = v === 'AUTO';
            if (!isLive) {
              void updateConfig({ autoEntryPaper: on }).catch((e) => setTradeMsg(e.message));
              return;
            }
            if (!on) {
              void updateConfig({ autoEntryLive: false }).catch((e) => setTradeMsg(e.message));
              return;
            }
            confirmDialog(
              'Turn on automatic LIVE entries?',
              'The app will place REAL buy orders on your Dhan account by itself whenever a signal is confirmed — with a stop-loss order at Dhan on every fill — while it is running. Your limits still apply: trades per day, no trade after a loss, daily max loss, the entry cutoff time, the premium filters and max lots. Auto refresh is switched on. Keep the app running (Settings → Run in background).',
              'Turn on',
              () => void updateConfig({ autoEntryLive: true, autoRefresh: true }).catch((e) => setTradeMsg(e.message)),
            );
          }}
        />
        <Text style={[ui.muted, isLive && { color: colors.down, fontWeight: '700' }]}>
          {isLive
            ? cfg.autoEntryLive
              ? 'LIVE · AUTOMATIC — confirmed signals place REAL orders on your Dhan account by themselves.'
              : 'LIVE · MANUAL — ENTER / EXIT place real orders on your Dhan account. Signals only alert you.'
            : cfg.autoEntryPaper !== false
              ? 'PAPER · AUTOMATIC — signals are traded on paper, nothing is sent to Dhan.'
              : 'PAPER · MANUAL — signals alert you; tap ENTER to take them on paper.'}
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
                / 100 confidence ·{' '}
                {isFut ? `${d.decision.direction} ${contract}` : `${d.decision.direction} ${d.decision.selectedStrike}`}
              </Text>
            </View>
            <ConfidenceMeter value={d.decision.confidence} watch={cfg.confWatch} high={cfg.confHigh} />
            <Text style={ui.muted}>
              {isFut ? 'Long' : 'CE'} score {formatNumber(d.decision.scoreCE, 1)} · {isFut ? 'Short' : 'PE'} score{' '}
              {formatNumber(d.decision.scorePE, 1)} · pattern {d.decision.pattern}
            </Text>
          </Card>

          {/* Manual entry / exit */}
          <Card style={{ gap: 10 }}>
            <Text style={[ui.sectionTitle, { marginTop: 0 }]}>Manual {isLive ? 'LIVE' : 'paper'} trade</Text>
            {pe ? (
              <>
                <Text style={ui.title}>
                  Entry order pending: {tradeLabel(pe.plan.direction, pe.plan.strike)} × {qtyLabel(pe.plan.qty)} @{' '}
                  {sideOfDir(pe.plan.direction) > 0 ? '≤' : '≥'} {formatNumber(pe.limit)}
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
                  busy
                    ? 'Working…'
                    : `EXIT ${p.direction === 'LONG' || p.direction === 'SHORT' ? `${p.direction} ${contract}` : `${p.direction} ${p.strike}`} × ${p.remainingQty}${isLive ? ' (LIVE)' : ''}`
                }
                color={colors.down}
                onPress={doExit}
                disabled={busy}
              />
            ) : cand ? (
              <>
                <LotStepper
                  lots={cfg.sizingMode === 'FIXED' ? cfg.fixedLots : Math.round(cand.qty / Math.max(1, isFut ? 1 : cfg.lotSize))}
                  fixed={cfg.sizingMode === 'FIXED'}
                  max={cfg.maxLots > 0 ? cfg.maxLots : 100}
                  unitsPerLot={isFut ? 1 : cfg.lotSize}
                  planLots={cand.qty > 0 ? Math.round(cand.qty / Math.max(1, isFut ? 1 : cfg.lotSize)) : 0}
                  cost={cand.qty > 0 ? cand.entry * cand.qty * (isFut ? 0 : 1) : null}
                  maxLoss={cand.qty > 0 ? cand.maxLoss : null}
                  onChange={(n) =>
                    void updateConfig({ sizingMode: 'FIXED', fixedLots: n }).catch((e) => setTradeMsg((e as Error).message))
                  }
                />
                <Text style={ui.muted}>
                  {isFut ? 'Price' : 'Premium'} now {formatNumber(cand.entry, dp)} · quantity {qtyLabel(cand.qty)}
                  {isFut ? ` · ₹${formatNumber(cfg.pointValue, 0)} per point per lot` : ''}
                </Text>
                {cand.sizing ? <Text style={[ui.muted, { fontSize: 12 }]}>Size: {cand.sizing}</Text> : null}
                {cand.blocked ? (
                  <Text style={{ color: colors.down, fontWeight: '600' }}>
                    Can&apos;t enter: {cand.blocked}. Change capital in Settings → Position size & capital.
                  </Text>
                ) : null}
                <View style={{ gap: 6 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={s.label}>
                      {sideOfDir(cand.direction) > 0 ? 'Buy' : 'Sell'} price —{' '}
                      {edited ? 'your limit' : 'market (edit to set your price)'}
                    </Text>
                    {edited ? (
                      <Text
                        style={[s.label, { color: colors.accent, fontWeight: '700' }]}
                        onPress={() => setPriceText(null)}
                        accessibilityRole="button"
                      >
                        Use market price
                      </Text>
                    ) : null}
                  </View>
                  <TextInput
                    style={[
                      s.input,
                      !limitValid && { borderColor: colors.down },
                      edited && { borderColor: colors.accent },
                    ]}
                    value={priceText}
                    onChangeText={(t) => {
                      setPriceText(t.replace(/[^\d.]/g, ''));
                      setTradeMsg(null);
                    }}
                    placeholder={`Market (~${formatNumber(cand.entry)})`}
                    placeholderTextColor={colors.muted}
                    keyboardType="decimal-pad"
                    selectTextOnFocus
                  />
                </View>
                <Text style={ui.muted}>
                  At {limit == null ? `market (~${formatNumber(atPrice)})` : formatNumber(atPrice)}: SL{' '}
                  {formatNumber(cand.sl + shift)} · T1 {formatNumber(cand.target1 + shift)} · T2{' '}
                  {formatNumber(cand.target2 + shift)} · max loss {formatINR(cand.maxLoss, 0)}. Daily limits still
                  apply.
                </Text>
                <Button
                  label={
                    busy
                      ? 'Working…'
                      : `ENTER ${tradeLabel(cand.direction, cand.strike)} × ${cand.qty} ${limit == null ? '@ market' : `@ ${formatNumber(limit, dp)} (limit)`}${isLive ? ' (LIVE)' : ''}`
                  }
                  color={cand.direction === 'CE' ? colors.up : colors.down}
                  onPress={doEnter}
                  disabled={busy || !!cand.blocked}
                />
              </>
            ) : (
              <Text style={ui.muted}>No strike available to enter yet.</Text>
            )}
            {tradeMsg ? <Text style={{ color: colors.down, fontWeight: '600' }}>{tradeMsg}</Text> : null}
          </Card>

          {p ? (
            <KV
              title={`Open position · ${p.direction === 'LONG' || p.direction === 'SHORT' ? `${p.direction} ${contract}` : `${p.direction} ${p.strike}`}`}
              rows={[
                ['Entry', p.entry],
                ...(p.live ? ([['Broker', p.live.broker === 'ANGEL' ? 'Angel One' : 'Dhan']] as [string, string][]) : []),
                [isFut ? 'Live price' : 'Live premium', liveLtp ?? '—'],
                ['Current (trailing) SL', p.currentSl, colors.down],
                ['Target 1', p.target1, colors.up],
                [
                  'Target 2',
                  cfg.profitLock || cfg.dayPlanLock ? `off (${cfg.dayPlanLock ? 'day plan' : 'profit lock'})` : p.target2,
                  colors.up,
                ],
                ...(cfg.dayPlanLock && p.dayPlan
                  ? ([
                      [
                        'Day plan',
                        p.dayPlan === 'FIRST'
                          ? `trade 1 ladder (${formatINR(cfg.dl1At, 0)}→${formatINR(cfg.dl1Lock, 0)}, ${formatINR(cfg.dl2At, 0)}→${formatINR(cfg.dl2Lock, 0)}, ${formatINR(cfg.dl3At, 0)}→${formatINR(cfg.dl3Lock, 0)})`
                          : p.dayPlan === 'SECOND'
                            ? `trade 2: day kept ≥ ${formatINR(cfg.dayFloor, 0)} (booked ${formatINR(p.dayBooked ?? 0, 0)})`
                            : 'profit lock',
                      ],
                    ] as [string, string | number, string?][])
                  : []),
                ...(cfg.profitLock || cfg.dayPlanLock
                  ? ([
                      ['Best profit (peak)', formatSigned(p.peakPnl ?? 0, 0)],
                      [
                        'Profit locked',
                        p.lockedPnl != null && p.lockedPnl > 0
                          ? `${formatINR(p.lockedPnl, 0)} secured`
                          : p.lockedPnl != null
                            ? `day floor: may lose ${formatINR(-p.lockedPnl, 0)} at most`
                            : `starts at ${formatINR(cfg.dayPlanLock && p.dayPlan === 'FIRST' ? cfg.dl1At : cfg.lockStart, 0)}`,
                        p.lockedPnl != null && p.lockedPnl > 0 ? colors.up : undefined,
                      ],
                    ] as [string, string | number, string?][])
                  : []),
                ...(cfg.lossTrail && !(p.lockedPnl != null && p.lockedPnl >= 0)
                  ? ([
                      [
                        'Loss trail',
                        p.lossCap != null
                          ? `may lose ${formatINR(p.lossCap, 0)} at most`
                          : `from ${formatINR(cfg.lt1At, 0)} profit: may lose ${formatINR(cfg.lt1Loss, 0)} at most`,
                      ],
                    ] as [string, string | number, string?][])
                  : []),
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
                isFut
                  ? ['Contract', `${d.plan.direction} ${contract}`]
                  : ['Selected strike', `${d.plan.strike} ${d.plan.direction}`],
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
              ...(isFut
                ? []
                : ([
                    [
                      'IV percentile',
                      d.decision.ivPercentile < 0
                        ? `building history (${st.ivSnapshots}/20)`
                        : `${formatNumber(d.decision.ivPercentile, 0)}%`,
                    ],
                  ] as [string, string][])),
            ]}
          />
          <KV
            title="Market"
            rows={[
              [isFut ? `${contract} LTP` : `${cfg.symbol} spot`, d.market.spot],
              ...(isFut ? [] : ([['ATM strike', String(d.market.atm)]] as [string, string][])),
              ['Trend', d.market.trend],
              ['VWAP', d.market.vwap],
              ['EMA20', d.market.ema20],
              ['EMA50', d.market.ema50],
              ['ATR', d.market.atr],
            ]}
          />
          {isFut && d.futures ? (
            <KV
              title={`Futures · ${d.futures.contract}`}
              rows={[
                ['Expiry', d.futures.expiry || '—'],
                ['Day open', d.futures.dayOpen],
                ['Open interest', d.futures.oi ? formatNumber(d.futures.oi, 0) : '—'],
                ['OI change (~30 min)', d.futures.oi ? formatSigned(d.futures.oiChange, 0) : '—'],
                ['OI reading', d.futures.buildup],
                ['Momentum (EMA spread / ATR)', formatNumber(d.futures.momentum, 2)],
                ['Price swing support', d.chain.swingSupport],
                ['Price swing resistance', d.chain.swingResistance],
              ]}
            />
          ) : (
            <>
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
            </>
          )}
          <FactorBreakdown factors={d.factors ?? []} total={d.decision.confidence} />
          {d.calibration && !d.calibration.base ? (
            <Text style={[ui.muted, { fontSize: 12 }]}>
              Score calibrated to NIFTY for {cfg.symbol}:{' '}
              {isFut
                ? `volatility ×${d.calibration.vol.toFixed(2)} (VWAP and day-open thresholds)`
                : `price ×${d.calibration.price.toFixed(2)} (gamma / theta), volatility ×${d.calibration.vol.toFixed(2)} (VWAP), lot ×${d.calibration.lot.toFixed(2)} (liquidity)`}
              {isFut
                ? '. MCX uses the futures factors (no option Greeks) on the same 0–100 scale and the same 80 / 65 levels.'
                : '. Same factors and weights as NIFTY; an 80 here means what 80 means on NIFTY.'}
            </Text>
          ) : null}
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
  stepRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  stepBtn: {
    width: 44,
    height: 40,
    borderRadius: 10,
    backgroundColor: colors.cardAlt,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  stepTxt: { color: colors.text, fontSize: 22, fontWeight: '800' },
  stepVal: { color: colors.text, fontSize: 22, fontWeight: '800', minWidth: 40, textAlign: 'center', fontVariant: ['tabular-nums'] },
  watchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 10,
  },
  watchScore: { fontSize: 20, fontWeight: '800', fontVariant: ['tabular-nums'] },
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
