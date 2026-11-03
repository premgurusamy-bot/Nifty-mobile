import { router, Stack, useLocalSearchParams } from 'expo-router';
import { ScrollView, Text, View } from 'react-native';
import { LineChart } from '../../components/LineChart';
import { Button, Card, Change, Stat, StatusPill, styles as ui } from '../../components/ui';
import { formatNumber, formatSigned } from '../../lib/format';
import { EQUITIES, displayName, isTradeable, kindOf, lotSize, parseOptionId } from '../../lib/instruments';
import { change, changePct } from '../../lib/simulator';
import { useMarket, useWatch } from '../../state/MarketContext';
import { usePortfolio } from '../../state/PortfolioContext';
import { colors, pnlColor } from '../../theme';

export default function InstrumentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { quotes, history, getPrice, status, spot, source } = useMarket();
  const { positionFor, mode } = usePortfolio();
  useWatch(id ? [id] : []);

  const quote = quotes[id];
  const ltp = getPrice(id);
  const kind = kindOf(id);
  const position = positionFor(id);
  const name = EQUITIES.find((e) => `NSE:${e.symbol}` === id)?.name;
  const opt = parseOptionId(id);

  if (ltp == null) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <Text style={ui.title}>Unknown instrument</Text>
      </View>
    );
  }

  const trade = (side: 'BUY' | 'SELL') => router.push({ pathname: '/order', params: { id, side } });

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Stack.Screen options={{ title: displayName(id) }} />
      <StatusPill status={status} live={source === 'DHAN'} />
      <Card>
        {name ? <Text style={ui.muted}>{name}</Text> : null}
        <Text style={ui.h1}>{formatNumber(ltp)}</Text>
        {quote ? <Change abs={change(quote)} pct={changePct(quote)} style={{ marginBottom: 12 }} /> : null}
        {quote ? (
          <>
            <LineChart data={history[id]} baseline={quote.prevClose} height={200} />
            <View style={{ flexDirection: 'row', marginTop: 12 }}>
              <Stat label="Open" value={formatNumber(quote.open)} />
              <Stat label="High" value={formatNumber(quote.high)} />
              <Stat label="Low" value={formatNumber(quote.low)} />
              <Stat label="Prev close" value={formatNumber(quote.prevClose)} />
            </View>
          </>
        ) : opt ? (
          <View style={{ flexDirection: 'row', marginTop: 8 }}>
            <Stat label="Underlying" value={formatNumber(spot)} />
            <Stat label="Strike" value={String(opt.strike)} />
            <Stat label="Expiry" value={opt.expiry} />
            <Stat label="Lot" value={String(lotSize(id))} />
          </View>
        ) : null}
      </Card>

      {position ? (
        <Card>
          <Text style={ui.sectionTitle}>Your position</Text>
          <View style={{ flexDirection: 'row', marginTop: 8 }}>
            <Stat label="Qty" value={String(position.qty)} />
            <Stat label="Avg price" value={formatNumber(position.avgPrice)} />
            <Stat
              label="P&L"
              value={formatSigned((ltp - position.avgPrice) * position.qty)}
              color={pnlColor(ltp - position.avgPrice)}
            />
          </View>
        </Card>
      ) : null}

      {isTradeable(id) ? (
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <Button label="BUY" color={colors.up} onPress={() => trade('BUY')} style={{ flex: 1 }} />
          <Button
            label="SELL"
            color={colors.down}
            onPress={() => trade('SELL')}
            disabled={mode === 'PAPER' && !position}
            style={{ flex: 1 }}
          />
        </View>
      ) : (
        <Text style={[ui.muted, { textAlign: 'center' }]}>
          {kind === 'INDEX'
            ? 'The index itself is not tradeable — use the Option Chain tab to trade NIFTY options.'
            : ''}
        </Text>
      )}
    </ScrollView>
  );
}
