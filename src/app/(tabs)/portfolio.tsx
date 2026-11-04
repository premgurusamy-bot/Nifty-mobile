import { Link, router } from 'expo-router';
import { Alert, FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { StrategyResultsCard } from '../../components/StrategyResults';
import { Card, Empty, Stat, styles as ui } from '../../components/ui';
import { formatINR, formatNumber, formatPct, formatSigned } from '../../lib/format';
import { displayName } from '../../lib/instruments';
import { STARTING_CASH } from '../../lib/portfolio';
import { useMarket } from '../../state/MarketContext';
import { usePortfolio } from '../../state/PortfolioContext';
import { colors, pnlColor } from '../../theme';

export default function PortfolioScreen() {
  const { getPrice, source } = useMarket();
  const p = usePortfolio();
  const live = p.mode === 'LIVE';
  const totalPnl = p.summary.equity - STARTING_CASH;
  const openOrders = p.orders.filter((o) => o.status === 'OPEN').length;

  const confirmReset = () => {
    const msg = 'Close all positions, clear orders and restore ₹10,00,000 virtual cash?';
    if (Platform.OS === 'web') {
      if (globalThis.confirm?.(msg)) p.reset();
      return;
    }
    Alert.alert('Reset paper account', msg, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reset', style: 'destructive', onPress: p.reset },
    ]);
  };

  const header = (
    <View style={{ padding: 16, gap: 12 }}>
      {p.error ? <Text style={s.error}>{p.error}</Text> : null}
      <StrategyResultsCard />
      <Text style={ui.sectionTitle}>{live ? 'Dhan account' : 'Manual paper account (stocks & options)'}</Text>
      <Card>
        <Text style={ui.muted}>
          {live
            ? 'Dhan account · LIVE'
            : `Manual buys from Markets / Option Chain · ${source === 'DHAN' ? 'Dhan live prices' : 'simulated prices'}`}
        </Text>
        <Text style={ui.h1}>{formatINR(p.summary.equity)}</Text>
        {live ? null : (
          <Text style={{ color: pnlColor(totalPnl), marginBottom: 14 }}>
            {formatSigned(totalPnl)} ({formatPct((totalPnl / STARTING_CASH) * 100)}) all time
          </Text>
        )}
        <View style={{ flexDirection: 'row', marginBottom: 12, marginTop: live ? 12 : 0 }}>
          <Stat label={live ? 'Available balance' : 'Available cash'} value={formatINR(p.cash, 0)} />
          <Stat label="Invested" value={formatINR(p.summary.invested, 0)} />
        </View>
        <View style={{ flexDirection: 'row' }}>
          <Stat
            label="Unrealised P&L"
            value={formatSigned(p.summary.unrealizedPnl)}
            color={pnlColor(p.summary.unrealizedPnl)}
          />
          <Stat label="Realised P&L" value={formatSigned(p.realizedPnl)} color={pnlColor(p.realizedPnl)} />
        </View>
        {live ? null : (
          <Text style={[ui.muted, { marginTop: 12, fontSize: 12 }]}>Charges paid: {formatINR(p.charges)}</Text>
        )}
      </Card>
      <Pressable onPress={() => router.push('/orders')} style={s.ordersLink}>
        <Text style={ui.title}>Orders</Text>
        <Text style={ui.muted}>
          {p.orders.length} today · {openOrders} open ›
        </Text>
      </Pressable>
      <Text style={ui.sectionTitle}>Positions ({p.rows.length})</Text>
    </View>
  );

  return (
    <FlatList
      style={{ backgroundColor: colors.bg }}
      data={p.rows}
      keyExtractor={(r) => r.key}
      ListHeaderComponent={header}
      ListEmptyComponent={
        <Empty title="No open positions" hint="Buy a stock from Markets or an option from the Option Chain." />
      }
      ListFooterComponent={
        live ? undefined : (
          <Pressable onPress={confirmReset} style={{ padding: 24, alignItems: 'center' }}>
            <Text style={{ color: colors.down, fontWeight: '600' }}>Reset paper account</Text>
          </Pressable>
        )
      }
      renderItem={({ item: r }) => {
        const ltp = getPrice(r.instrumentId);
        const pnl = ltp != null ? (ltp - r.avgPrice) * r.qty : (r.unrealized ?? 0);
        const pct = ltp != null && r.avgPrice ? ((ltp - r.avgPrice) / r.avgPrice) * 100 * Math.sign(r.qty) : 0;
        return (
          <Link href={{ pathname: '/instrument/[id]', params: { id: r.instrumentId } }} asChild>
            <Pressable>
              {({ pressed }) => (
                <View style={[s.row, pressed && { backgroundColor: colors.cardAlt }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={ui.title}>{displayName(r.instrumentId)}</Text>
                    <Text style={ui.muted}>
                      {r.tag ? `${r.tag} · ` : ''}Qty {r.qty} · Avg {formatNumber(r.avgPrice)}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ color: pnlColor(pnl), fontWeight: '600', fontVariant: ['tabular-nums'] }}>
                      {formatSigned(pnl)}
                    </Text>
                    <Text style={ui.muted}>
                      {ltp != null ? `LTP ${formatNumber(ltp)} (${formatPct(pct)})` : 'LTP —'}
                    </Text>
                  </View>
                </View>
              )}
            </Pressable>
          </Link>
        );
      }}
    />
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  ordersLink: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  error: { color: '#fff', backgroundColor: '#7F1D1D', padding: 10, borderRadius: 10 },
});
