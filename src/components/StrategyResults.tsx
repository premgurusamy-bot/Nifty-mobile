import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { istDate, positionLabel } from '../lib/engine/decision';
import type { TradeMode } from '../lib/engine/types';
import { formatINR, formatNumber, formatPct, formatSigned } from '../lib/format';
import { rowMode, strategyResults } from '../lib/results';
import { useEngine } from '../state/EngineContext';
import { colors, pnlColor } from '../theme';
import { Card, Segmented, Stat, styles as ui } from './ui';

const signed = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '') + formatINR(Math.abs(n), 0);

/** The engine's trading results (from the trade journal), for PAPER or LIVE. */
export function StrategyResultsCard() {
  const { snap } = useEngine();
  const [pick, setPick] = useState<TradeMode | null>(null);
  if (!snap) return null;
  const cfg = snap.config;
  const mode = pick ?? cfg.tradeMode;
  const journal = snap.state.journal;
  // The engine's own trading day (IST), so demo days work too.
  const today = snap.state.day || (snap.lastRefresh ? istDate(snap.lastRefresh) : '');
  const r = strategyResults(journal, mode, today);

  const pos = snap.state.position;
  const posMode: TradeMode | null = pos ? (pos.live ? 'LIVE' : 'PAPER') : null;
  const openTrade = pos && posMode === mode ? (snap.live?.tradePnl ?? null) : null;
  const capital = mode === 'PAPER' ? cfg.capitalPaper : cfg.capitalLive > 0 ? cfg.capitalLive : null;
  const equity = capital != null ? capital + r.net + (openTrade ?? 0) : null;
  const allTime = r.net + (openTrade ?? 0);
  const afterCharges = r.estCharges != null ? r.net - r.estCharges : null;
  const hasAny = journal.some((j) => rowMode(j) === mode);

  return (
    <Card style={{ gap: 12 }}>
      <View style={st.head}>
        <Text style={[ui.sectionTitle, { marginTop: 0 }]}>Strategy results</Text>
        <Text style={ui.muted}>{snap.demo ? 'demo data' : 'Dhan prices'}</Text>
      </View>
      <Segmented
        options={[
          { label: 'PAPER', value: 'PAPER' as TradeMode },
          { label: 'LIVE', value: 'LIVE' as TradeMode },
        ]}
        value={mode}
        onChange={setPick}
      />

      {equity != null ? (
        <View style={{ gap: 2 }}>
          <Text style={ui.muted}>Equity on {formatINR(capital!, 0)} {mode === 'PAPER' ? 'paper' : 'live'} capital</Text>
          <Text accessibilityLabel="Strategy equity" style={ui.h1}>
            {formatINR(equity, 0)}
          </Text>
          <Text style={{ color: pnlColor(allTime) }}>
            {signed(allTime)} ({formatPct((allTime / capital!) * 100)}) all time
            {openTrade != null ? ' · incl. open trade' : ''}
          </Text>
        </View>
      ) : (
        <View style={{ gap: 2 }}>
          <Text style={ui.muted}>LIVE P&amp;L all time (balance: see your Dhan account below)</Text>
          <Text style={[ui.h1, { color: pnlColor(allTime) }]}>{signed(allTime)}</Text>
        </View>
      )}

      {!hasAny ? (
        <Text style={ui.muted}>
          No {mode} trades yet. Results appear here as the engine trades (or you tap ENTER) in {mode} mode.
        </Text>
      ) : (
        <>
          <View style={st.row}>
            <Stat
              label="Today"
              value={signed(r.today + (openTrade ?? 0))}
              color={pnlColor(r.today + (openTrade ?? 0))}
            />
            <Stat label="Closed trades" value={String(r.trades)} />
            <Stat label="Win rate" value={r.winRate == null ? '—' : `${formatNumber(r.winRate, 0)}%`} />
          </View>
          <View style={st.row}>
            <Stat label="Wins / losses" value={`${r.wins} / ${r.losses}`} />
            <Stat label="Profit factor" value={r.profitFactor == null ? '—' : formatNumber(r.profitFactor, 2)} />
            <Stat label="Max drawdown" value={signed(r.maxDrawdown)} color={r.maxDrawdown < 0 ? colors.down : undefined} />
          </View>
          <View style={st.row}>
            <Stat label="Avg win" value={r.avgWin == null ? '—' : signed(r.avgWin)} color={colors.up} />
            <Stat label="Avg loss" value={r.avgLoss == null ? '—' : signed(r.avgLoss)} color={colors.down} />
            <Stat
              label="Best / worst"
              value={r.best == null ? '—' : `${formatSigned(r.best, 0)} / ${formatSigned(r.worst!, 0)}`}
            />
          </View>
          <View style={st.row}>
            <Stat label="Gross profit" value={signed(r.grossProfit)} color={colors.up} />
            <Stat label="Gross loss" value={signed(r.grossLoss)} color={colors.down} />
            <Stat label="Net (closed)" value={signed(r.net)} color={pnlColor(r.net)} />
          </View>
          {mode === 'PAPER' ? (
            <Text style={[ui.muted, { fontSize: 12 }]}>
              {r.estCharges != null
                ? `Paper fills include no charges. Estimated charges ${formatINR(r.estCharges, 0)} → net after charges ${signed(afterCharges!)}`
                : 'Paper fills include no charges.'}
              {r.chargesUnknown ? ` (${r.chargesUnknown} older or MCX trade${r.chargesUnknown > 1 ? 's' : ''} not estimated)` : ''}
              . Slippage is not included.
            </Text>
          ) : (
            <Text style={[ui.muted, { fontSize: 12 }]}>
              LIVE results use Dhan&apos;s fill prices. Charges are deducted by Dhan from your balance, not here.
            </Text>
          )}

          {pos && posMode === mode ? (
            <View style={st.trade}>
              <View style={{ flex: 1 }}>
                <Text style={ui.title}>Open · {positionLabel(pos)}</Text>
                <Text style={ui.muted}>
                  {pos.remainingQty} @ {formatNumber(pos.entry)} · SL {formatNumber(pos.currentSl)}
                </Text>
              </View>
              <Text style={[st.pnl, { color: pnlColor(openTrade ?? 0) }]}>{openTrade == null ? '—' : signed(openTrade)}</Text>
            </View>
          ) : null}

          {r.recent.length ? <Text style={ui.muted}>Recent closed trades</Text> : null}
          {r.recent.slice(0, 8).map((j) => (
            <View key={j.id} style={st.trade}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={ui.title}>
                  {positionLabel({ direction: j.direction, strike: j.strike, symbol: j.symbol })}
                </Text>
                <Text style={ui.muted} numberOfLines={2}>
                  {j.date.slice(5)} {j.time.slice(0, 5)}
                  {j.exitTime ? `–${j.exitTime.slice(0, 5)}` : ''} · {formatNumber(j.entry)} → {formatNumber(j.exit ?? 0)}
                  {j.qty ? ` × ${j.qty}` : ''} · {j.exitReason.split(' (')[0]}
                </Text>
              </View>
              <Text style={[st.pnl, { color: pnlColor(j.pnl!) }]}>{signed(j.pnl!)}</Text>
            </View>
          ))}
          <Text style={[ui.muted, { fontSize: 12 }]}>Every trade is in the Journal tab (and exportable there).</Text>
        </>
      )}
    </Card>
  );
}

const st = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  row: { flexDirection: 'row', gap: 8 },
  trade: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  pnl: { fontWeight: '700', fontVariant: ['tabular-nums'] },
});
