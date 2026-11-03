import { Alert, FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Empty, styles as ui } from '../components/ui';
import { formatNumber } from '../lib/format';
import { displayName } from '../lib/instruments';
import type { Order, OrderStatus } from '../lib/portfolio';
import { usePortfolio } from '../state/PortfolioContext';
import { colors } from '../theme';

const STATUS_COLOR: Record<OrderStatus, string> = {
  OPEN: colors.warn,
  FILLED: colors.up,
  CANCELLED: colors.muted,
  REJECTED: colors.down,
};

const time = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
};

const alertError = (msg: string) =>
  Platform.OS === 'web' ? globalThis.alert?.(msg) : Alert.alert('Cancel failed', msg);

export default function OrdersScreen() {
  const { orders, cancelOrder, mode } = usePortfolio();

  const renderItem = ({ item: o }: { item: Order }) => (
    <View style={s.row}>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <Text style={[s.side, { color: o.side === 'BUY' ? colors.up : colors.down }]}>{o.side}</Text>
          <Text style={ui.title}>{displayName(o.instrumentId)}</Text>
        </View>
        <Text style={ui.muted}>
          {o.qty} × {o.type === 'LIMIT' ? `LMT ${formatNumber(o.limitPrice!)}` : 'MKT'}
          {o.fillPrice != null ? ` · filled @ ${formatNumber(o.fillPrice)}` : ''} · {time(o.createdAt)}
        </Text>
        {o.reason ? <Text style={{ color: colors.down, fontSize: 12 }}>{o.reason}</Text> : null}
      </View>
      <View style={{ alignItems: 'flex-end', gap: 6 }}>
        <Text style={[s.status, { color: STATUS_COLOR[o.status] }]}>{o.status}</Text>
        {o.status === 'OPEN' && (
          <Pressable onPress={() => void cancelOrder(o.id).catch((e) => alertError(e.message))} hitSlop={8}>
            <Text style={{ color: colors.accent, fontWeight: '600' }}>Cancel</Text>
          </Pressable>
        )}
      </View>
    </View>
  );

  return (
    <FlatList
      style={{ backgroundColor: colors.bg }}
      data={orders}
      keyExtractor={(o) => o.id}
      renderItem={renderItem}
      ListHeaderComponent={
        <Text style={[ui.muted, { padding: 16, paddingBottom: 4 }]}>
          {mode === 'LIVE' ? "Dhan order book (today's orders)" : 'Paper orders (simulated fills)'}
        </Text>
      }
      ListEmptyComponent={<Empty title="No orders yet" hint="Orders you place will appear here." />}
    />
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  side: { fontWeight: '800', fontSize: 12 },
  status: { fontWeight: '700', fontSize: 12 },
});
