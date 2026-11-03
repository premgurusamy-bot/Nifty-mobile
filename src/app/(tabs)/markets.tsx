import { Link } from 'expo-router';
import { FlatList, Pressable, Text, View } from 'react-native';
import { LineChart } from '../../components/LineChart';
import { QuoteRow } from '../../components/QuoteRow';
import { Card, Change, StatusPill, Stat, styles } from '../../components/ui';
import { formatNumber } from '../../lib/format';
import { EQUITIES, NIFTY_ID, equityId } from '../../lib/instruments';
import { change, changePct } from '../../lib/simulator';
import { useMarket } from '../../state/MarketContext';
import { colors } from '../../theme';

export default function MarketsScreen() {
  const { quotes, history, status, source } = useMarket();
  const nifty = quotes[NIFTY_ID];

  const header = (
    <View style={{ padding: 16, gap: 12 }}>
      <StatusPill status={status} live={source === 'DHAN'} />
      <Link href={{ pathname: '/instrument/[id]', params: { id: NIFTY_ID } }} asChild>
        <Pressable>
          <Card>
            <Text style={styles.muted}>NIFTY 50</Text>
            <Text style={styles.h1}>{formatNumber(nifty.ltp)}</Text>
            <Change abs={change(nifty)} pct={changePct(nifty)} style={{ fontSize: 14, marginBottom: 12 }} />
            <LineChart data={history[NIFTY_ID]} baseline={nifty.prevClose} height={120} />
            <View style={{ flexDirection: 'row', marginTop: 12 }}>
              <Stat label="Open" value={formatNumber(nifty.open)} />
              <Stat label="High" value={formatNumber(nifty.high)} />
              <Stat label="Low" value={formatNumber(nifty.low)} />
              <Stat label="Prev close" value={formatNumber(nifty.prevClose)} />
            </View>
          </Card>
        </Pressable>
      </Link>
      <Text style={styles.sectionTitle}>Watchlist · NIFTY 50 stocks</Text>
    </View>
  );

  return (
    <FlatList
      style={{ backgroundColor: colors.bg }}
      data={EQUITIES}
      keyExtractor={(e) => e.symbol}
      ListHeaderComponent={header}
      renderItem={({ item }) => {
        const id = equityId(item.symbol);
        return <QuoteRow quote={quotes[id]} name={item.name} history={history[id]} />;
      }}
    />
  );
}
