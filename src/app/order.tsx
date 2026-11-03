import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Product } from '../lib/apiTypes';
import { Button, Segmented, Stat, styles as ui } from '../components/ui';
import { formatINR, formatNumber } from '../lib/format';
import { displayName, kindOf, lotSize } from '../lib/instruments';
import { BROKERAGE_PER_ORDER, validateRequest, type OrderType, type Side } from '../lib/portfolio';
import { useMarket, useWatch } from '../state/MarketContext';
import { usePortfolio } from '../state/PortfolioContext';
import { colors } from '../theme';

export default function OrderScreen() {
  const params = useLocalSearchParams<{ id: string; side?: Side }>();
  const id = params.id;
  const { getPrice } = useMarket();
  const { positionFor, placeOrder, mode, cash } = usePortfolio();
  const live = mode === 'LIVE';
  useWatch(id ? [id] : []);
  const [product, setProduct] = useState<Product>('INTRADAY');
  const [submitting, setSubmitting] = useState(false);

  const [side, setSide] = useState<Side>(params.side === 'SELL' ? 'SELL' : 'BUY');
  const [type, setType] = useState<OrderType>('MARKET');
  const lot = lotSize(id);
  const isOption = kindOf(id) === 'OPTION';
  const [qtyText, setQtyText] = useState('1'); // lots for options, shares otherwise
  const ltp = getPrice(id) ?? 0;
  const [limitText, setLimitText] = useState(() => ltp.toFixed(2));
  // Live quotes can arrive after the ticket opens; prefill the limit once they do.
  useEffect(() => {
    if (ltp > 0 && (limitText === '0.00' || !limitText)) setLimitText(ltp.toFixed(2));
  }, [ltp, limitText]);
  const [error, setError] = useState<string | null>(null);

  const qty = (parseInt(qtyText, 10) || 0) * lot;
  const limitPrice = parseFloat(limitText);
  const price = type === 'LIMIT' && limitPrice > 0 ? limitPrice : ltp;
  const value = qty * price;
  const held = positionFor(id)?.qty ?? 0;

  const send = async () => {
    const req = { instrumentId: id, side, qty, type, limitPrice: type === 'LIMIT' ? limitPrice : undefined, product };
    setSubmitting(true);
    try {
      const order = await placeOrder(req);
      if (order.status === 'REJECTED') return setError(order.reason ?? 'Order rejected');
      router.replace('/orders');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const submit = () => {
    const err = validateRequest({
      instrumentId: id,
      side,
      qty,
      type,
      limitPrice: type === 'LIMIT' ? limitPrice : undefined,
    });
    if (err) return setError(err);
    if (!live) return void send();
    // Real money: always confirm.
    const msg = `${side} ${qty} ${displayName(id)} @ ${type === 'LIMIT' ? formatNumber(limitPrice) : 'MARKET'} (${product}) on your Dhan account?`;
    if (Platform.OS === 'web') {
      if (globalThis.confirm?.(msg)) void send();
      return;
    }
    Alert.alert('Place LIVE order', msg, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Place order', style: 'destructive', onPress: () => void send() },
    ]);
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
        {live ? (
          <Segmented
            options={[
              { label: 'Intraday', value: 'INTRADAY' as Product },
              { label: isOption ? 'Carry forward (NRML)' : 'Delivery (CNC)', value: 'DELIVERY' as Product },
            ]}
            value={product}
            onChange={setProduct}
          />
        ) : null}

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
          <Stat label={live ? 'Available balance' : 'Available cash'} value={formatINR(cash)} />
          <Stat label="Held" value={String(held)} />
        </View>
        {live ? (
          <Text style={[ui.muted, { color: colors.warn }]}>
            LIVE — this order goes to your Dhan account. Dhan's charges and margin rules apply.
          </Text>
        ) : (
          <Text style={ui.muted}>
            Brokerage {formatINR(BROKERAGE_PER_ORDER, 0)} per executed order. Paper trading — no real money is used.
          </Text>
        )}

        {error ? <Text style={{ color: colors.down, fontWeight: '600' }}>{error}</Text> : null}
        <Button
          label={submitting ? 'Placing…' : `${side === 'BUY' ? 'Buy' : 'Sell'} ${qty || ''}${live ? ' (LIVE)' : ''}`}
          color={sideColor}
          onPress={submit}
          disabled={qty <= 0 || submitting}
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
