import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import type { Product } from '../lib/apiTypes';
import { Button, Segmented, Stat, styles as ui } from '../components/ui';
import { formatINR, formatNumber } from '../lib/format';
import { displayName, kindOf, lotSize, parseOptionId } from '../lib/instruments';
import { BROKERAGE_PER_ORDER, validateRequest, type OrderType, type Side } from '../lib/portfolio';
import { useMarket, useWatch } from '../state/MarketContext';
import { useEngine } from '../state/EngineContext';
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
  // Until the user types a limit, it follows the LTP (live quotes can arrive after the ticket opens).
  const [limitEdit, setLimitText] = useState<string | null>(null);
  const limitText = limitEdit ?? ltp.toFixed(2);
  const [error, setError] = useState<string | null>(null);

  // Option Chain BUY on an index the engine trades → an engine trade (shown on the Dashboard, with the
  // engine's stop-loss, Target 1, profit lock, day plan and daily rules), in the engine's PAPER / LIVE mode.
  const { snap, phone, enterStrike } = useEngine();
  const opt = parseOptionId(id);
  const cfg = snap?.config;
  const watched = (cfg as { watchSymbols?: string[] } | undefined)?.watchSymbols ?? [];
  const engineExpiry = snap?.dashboard?.expiry ?? '';
  const engineIndex = !!opt && !!cfg && (opt.underlying === cfg.symbol || watched.includes(opt.underlying));
  const expiryOk = !!opt && (!engineExpiry || opt.expiry === engineExpiry);
  const canEngine = engineIndex && expiryOk && (phone || !!snap?.demo);
  const [withEngine, setWithEngine] = useState(true);
  const viaEngine = canEngine && withEngine && side === 'BUY';
  const engineLive = cfg?.tradeMode === 'LIVE';

  const qty = (parseInt(qtyText, 10) || 0) * lot;
  const limitPrice = parseFloat(limitText);
  const price = type === 'LIMIT' && limitPrice > 0 ? limitPrice : ltp;
  const value = qty * price;
  const held = positionFor(id)?.qty ?? 0;

  const sendEngine = async () => {
    setSubmitting(true);
    try {
      await enterStrike({
        symbol: opt!.underlying,
        direction: opt!.type,
        strike: opt!.strike,
        qty,
        limit: type === 'LIMIT' ? limitPrice : undefined,
        expiry: opt!.expiry,
      });
      router.replace('/');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

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
    if (viaEngine) {
      if (!engineLive) return void sendEngine();
      const m = `LIVE engine trade: BUY ${qty} ${displayName(id)} @ ${type === 'LIMIT' ? formatNumber(limitPrice) : 'MARKET'} on your broker account, with the exchange stop-loss and the engine's Target 1 / profit lock?`;
      if (Platform.OS === 'web') {
        if (globalThis.confirm?.(m)) void sendEngine();
        return;
      }
      return Alert.alert('Place LIVE engine trade', m, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Place trade', style: 'destructive', onPress: () => void sendEngine() },
      ]);
    }
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
        {canEngine && side === 'BUY' ? (
          <View style={s.engineBox}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <Text style={{ color: colors.text, fontWeight: '700', flexShrink: 1 }}>Trade with the engine</Text>
              <Switch value={withEngine} onValueChange={setWithEngine} accessibilityLabel="Trade with the engine" />
            </View>
            <Text style={ui.muted}>
              {withEngine
                ? `Shown on the Dashboard and managed like an engine trade: stop-loss, Target 1 (50%), profit lock, day plan and the daily rules. ${engineLive ? 'LIVE: a real order with the exchange stop-loss.' : 'PAPER: no real order.'}`
                : 'Off: a separate manual position in Portfolio — no stop-loss, Target 1 or profit lock; you exit it yourself.'}
            </Text>
          </View>
        ) : opt && engineIndex && !expiryOk && side === 'BUY' ? (
          <Text style={[ui.muted, { color: colors.warn }]}>
            The engine trades the {engineExpiry} expiry, so this {opt.expiry} option is a manual position (no engine stop-loss / profit lock).
          </Text>
        ) : null}
        {live && !viaEngine ? (
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
        {viaEngine ? null : live ? (
          <Text style={[ui.muted, { color: colors.warn }]}>
            LIVE — this order goes to your Dhan account. Dhan&apos;s charges and margin rules apply.
            {isOption && side === 'BUY' ? ' No stop-loss is placed for a manual order.' : ''}
          </Text>
        ) : (
          <Text style={ui.muted}>
            Brokerage {formatINR(BROKERAGE_PER_ORDER, 0)} per executed order. Paper trading — no real money is used.
          </Text>
        )}

        {error ? <Text style={{ color: colors.down, fontWeight: '600' }}>{error}</Text> : null}
        <Button
          label={
            submitting
              ? 'Placing…'
              : viaEngine
                ? `Buy ${qty || ''} with the engine${engineLive ? ' (LIVE)' : ' (paper)'}`
                : `${side === 'BUY' ? 'Buy' : 'Sell'} ${qty || ''}${live ? ' (LIVE)' : ''}`
          }
          color={sideColor}
          onPress={submit}
          disabled={qty <= 0 || submitting}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  engineBox: { gap: 6, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.accent, backgroundColor: colors.card },
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
