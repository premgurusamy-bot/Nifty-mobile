import { Link } from 'expo-router';
import { Alert, FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Card, Empty, Stat, styles as ui } from '../../components/ui';
import { formatINR, formatNumber, formatPct, formatSigned } from '../../lib/format';
import { displayName } from '../../lib/instruments';
import { STARTING_CASH } from '../../lib/portfolio';
import { useMarket } from '../../state/MarketContext';
import { usePortfolio } from '../../state/PortfolioContext';
import { colors, pnlColor } from '../../theme';

export default function PortfolioScreen() {
  const { getPrice } = useMarket();
  const { state, summary, reset } = usePortfolio();
  const positions = Object.entries(state.positions);
  const totalPnl = summary.equity - STARTING_CASH;

  const confirmReset = () => {
    const msg = 'Close all positions, clear orders and restore ₹10,00,000 virtual cash?';
    if (Platform.OS === 'web') {
      if (globalThis.confirm?.(msg)) reset();
      return;
    }
    Alert.alert('Reset paper account', msg, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reset', style: 'destructive', onPress: reset },
    ]);
  };

  const header = (
    <View style={{ padding: 16, gap: 12 }}>
      <Card>
        <Text style={ui.muted}>Account value (paper)</Text>
        <Text style={ui.h1}>{formatINR(summary.equity)}</Text>
        <Text style={{ color: pnlColor(totalPnl), marginBottom: 14 }}>
          {formatSigned(totalPnl)} ({formatPct((totalPnl / STARTING_CASH) * 100)}) all time
        </Text>
        <View style={{ flexDirection: 'row', marginBottom: 12 }}>
          <Stat label="Available cash" value={formatINR(state.cash, 0)} />
          <Stat label="Invested" value={formatINR(summary.invested, 0)} />
        </View>
        <View style={{ flexDirection: 'row' }}>
          <Stat
            label="Unrealised P&L"
            value={formatSigned(summary.unrealizedPnl)}
            color={pnlColor(summary.unrealizedPnl)}
          />
          <Stat label="Realised P&L" value={formatSigned(state.realizedPnl)} color={pnlColor(state.realizedPnl)} />
        </View>
        <Text style={[ui.muted, { marginTop: 12, fontSize: 12 }]}>Charges paid: {formatINR(state.charges)}</Text>
      </Card>
      <Text style={ui.sectionTitle}>Positions ({positions.length})</Text>
    </View>
  );

  return (
    <FlatList
      style={{ backgroundColor: colors.bg }}
      data={positions}
      keyExtractor={([id]) => id}
      ListHeaderComponent={header}
      ListEmptyComponent={
        <Empty title="No open positions" hint="Buy a stock from Markets or an option from the Option Chain." />
      }
      ListFooterComponent={
        <Pressable onPress={confirmReset} style={{ padding: 24, alignItems: 'center' }}>
          <Text style={{ color: colors.down, fontWeight: '600' }}>Reset paper account</Text>
        </Pressable>
      }
      renderItem={({ item: [id, p] }) => {
        const ltp = getPrice(id) ?? p.avgPrice;
        const pnl = (ltp - p.avgPrice) * p.qty;
        const pct = ((ltp - p.avgPrice) / p.avgPrice) * 100;
        return (
          <Link href={{ pathname: '/instrument/[id]', params: { id } }} asChild>
            <Pressable>
              {({ pressed }) => (
                <View style={[s.row, pressed && { backgroundColor: colors.cardAlt }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={ui.title}>{displayName(id)}</Text>
                    <Text style={ui.muted}>
                      Qty {p.qty} · Avg {formatNumber(p.avgPrice)}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ color: pnlColor(pnl), fontWeight: '600', fontVariant: ['tabular-nums'] }}>
                      {formatSigned(pnl)}
                    </Text>
                    <Text style={ui.muted}>
                      LTP {formatNumber(ltp)} ({formatPct(pct)})
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
});
