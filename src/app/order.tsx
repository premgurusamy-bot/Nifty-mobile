import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button, Segmented, Stat, styles as ui } from '../components/ui';
import { formatINR, formatNumber } from '../lib/format';
import { displayName, kindOf, lotSize } from '../lib/instruments';
import { BROKERAGE_PER_ORDER, validateRequest, type OrderType, type Side } from '../lib/portfolio';
import { useMarket } from '../state/MarketContext';
import { usePortfolio } from '../state/PortfolioContext';
import { colors } from '../theme';

export default function OrderScreen() {
  const params = useLocalSearchParams<{ id: string; side?: Side }>();
  const id = params.id;
  const { getPrice } = useMarket();
  const { state, placeOrder } = usePortfolio();

  const [side, setSide] = useState<Side>(params.side === 'SELL' ? 'SELL' : 'BUY');
  const [type, setType] = useState<OrderType>('MARKET');
  const lot = lotSize(id);
  const isOption = kindOf(id) === 'OPTION';
  const [qtyText, setQtyText] = useState('1'); // lots for options, shares otherwise
  const ltp = getPrice(id) ?? 0;
  const [limitText, setLimitText] = useState(() => ltp.toFixed(2));
  const [error, setError] = useState<string | null>(null);

  const qty = (parseInt(qtyText, 10) || 0) * lot;
  const limitPrice = parseFloat(limitText);
  const price = type === 'LIMIT' && limitPrice > 0 ? limitPrice : ltp;
  const value = qty * price;
  const held = state.positions[id]?.qty ?? 0;

  const submit = () => {
    const req = { instrumentId: id, side, qty, type, limitPrice: type === 'LIMIT' ? limitPrice : undefined };
    const err = validateRequest(req);
    if (err) return setError(err);
    const order = placeOrder(req);
    if (order.status === 'REJECTED') return setError(order.reason ?? 'Order rejected');
    router.back();
    router.navigate('/orders');
  };

  const sideColor = side === 'BUY' ? colors.up : colors.down;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }} keyboardShouldPersistTaps="handled">
        <View>
          <Text style={[ui.title, { fontSize: 20 }]}>{displayName(id)}</Text>
          <Text style={ui.muted}>
            LTP {formatNumber(ltp)}
            {isOption ? ` · Lot size ${lot}` : ''}
          </Text>
        </View>

        <Segmented
          options={[
            { label: 'Buy', value: 'BUY' as Side },
            { label: 'Sell', value: 'SELL' as Side },
          ]}
          value={side}
          onChange={setSide}
        />
        <Segmented
          options={[
            { label: 'Market', value: 'MARKET' as OrderType },
            { label: 'Limit', value: 'LIMIT' as OrderType },
          ]}
          value={type}
          onChange={setType}
        />

        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={s.label}>{isOption ? 'Lots' : 'Quantity'}</Text>
            <TextInput
              style={s.input}
              keyboardType="number-pad"
              value={qtyText}
              onChangeText={(t) => {
                setQtyText(t.replace(/\D/g, ''));
                setError(null);
              }}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.label}>Price</Text>
            <TextInput
              style={[s.input, type === 'MARKET' && { color: colors.muted }]}
              editable={type === 'LIMIT'}
              keyboardType="decimal-pad"
              value={type === 'LIMIT' ? limitText : 'Market'}
              onChangeText={(t) => {
                setLimitText(t.replace(/[^\d.]/g, ''));
                setError(null);
              }}
            />
          </View>
        </View>

        <View style={{ flexDirection: 'row' }}>
          <Stat label={isOption ? `Units (${qtyText || 0} × ${lot})` : 'Units'} value={String(qty)} />
          <Stat label="Approx. value" value={formatINR(value)} />
        </View>
        <View style={{ flexDirection: 'row' }}>
          <Stat label="Available cash" value={formatINR(state.cash)} />
          <Stat label="Held" value={String(held)} />
        </View>
        <Text style={ui.muted}>
          Brokerage {formatINR(BROKERAGE_PER_ORDER, 0)} per executed order. Paper trading — no real money is used.
        </Text>

        {error ? <Text style={{ color: colors.down, fontWeight: '600' }}>{error}</Text> : null}
        <Button
          label={`${side === 'BUY' ? 'Buy' : 'Sell'} ${qty || ''}`}
          color={sideColor}
          onPress={submit}
          disabled={qty <= 0}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  label: { color: colors.muted, fontSize: 12, marginBottom: 6 },
  input: {
    backgroundColor: colors.card,
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
