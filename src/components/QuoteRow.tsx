import { Link } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatNumber } from '../lib/format';
import { change, changePct, type Quote } from '../lib/simulator';
import { colors } from '../theme';
import { LineChart } from './LineChart';
import { Change } from './ui';

export function QuoteRow({ quote, name, history }: { quote: Quote; name: string; history: number[] }) {
  const symbol = quote.id.replace(/^NSE:/, '');
  return (
    <Link href={{ pathname: '/instrument/[id]', params: { id: quote.id } }} asChild>
      <Pressable>
        {({ pressed }) => (
          <View style={[s.row, pressed && { backgroundColor: colors.cardAlt }]}>
            <View style={{ flex: 1 }}>
              <Text style={s.symbol}>{symbol}</Text>
              <Text style={s.name} numberOfLines={1}>
                {name}
              </Text>
            </View>
            <View style={{ width: 64 }}>
              <LineChart data={history.slice(-60)} height={28} baseline={quote.prevClose} showFill={false} />
            </View>
            <View style={{ alignItems: 'flex-end', minWidth: 112 }}>
              <Text style={s.ltp}>{formatNumber(quote.ltp)}</Text>
              <Change abs={change(quote)} pct={changePct(quote)} style={{ fontSize: 12 }} />
            </View>
          </View>
        )}
      </Pressable>
    </Link>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  symbol: { color: colors.text, fontWeight: '600', fontSize: 15 },
  name: { color: colors.muted, fontSize: 12, marginTop: 2 },
  ltp: { color: colors.text, fontWeight: '600', fontSize: 15, fontVariant: ['tabular-nums'] },
});
