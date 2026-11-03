import { router } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Change, Segmented, StatusPill, styles as ui } from '../../components/ui';
import { formatNumber } from '../../lib/format';
import { NIFTY_ID, NIFTY_LOT_SIZE } from '../../lib/instruments';
import { atmStrike, buildChain, type ChainRow } from '../../lib/optionChain';
import { change, changePct } from '../../lib/simulator';
import { upcomingExpiries } from '../../lib/time';
import { useMarket } from '../../state/MarketContext';
import { colors } from '../../theme';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (iso: string) => {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
};

const CHAIN_WIDTH = 10;
const ROW_HEIGHT = 54;

const openTicket = (id: string) => router.push({ pathname: '/order', params: { id, side: 'BUY' } });

export default function OptionChainScreen() {
  const { spot, now, quotes, status } = useMarket();
  const expiries = upcomingExpiries(now, 3);
  const [expiry, setExpiry] = useState(expiries[0]);
  const active = expiries.includes(expiry) ? expiry : expiries[0];
  const rows = buildChain(spot, active, now, CHAIN_WIDTH);
  const atm = atmStrike(spot);
  const nifty = quotes[NIFTY_ID];

  const renderRow = ({ item }: { item: ChainRow }) => {
    const ceITM = item.strike < spot;
    const peITM = item.strike > spot;
    return (
      <View style={[s.row, item.strike === atm && s.atmRow]}>
        <Pressable style={[s.cell, ceITM && s.itm]} onPress={() => openTicket(item.ce.id)}>
          <Text style={s.price}>{formatNumber(item.ce.ltp)}</Text>
          <Text style={s.sub}>Δ {item.ce.delta.toFixed(2)}</Text>
        </Pressable>
        <View style={s.strike}>
          <Text style={s.strikeText}>{item.strike}</Text>
          <Text style={s.sub}>IV {(item.ce.iv * 100).toFixed(1)}</Text>
        </View>
        <Pressable style={[s.cell, peITM && s.itm]} onPress={() => openTicket(item.pe.id)}>
          <Text style={s.price}>{formatNumber(item.pe.ltp)}</Text>
          <Text style={s.sub}>Δ {item.pe.delta.toFixed(2)}</Text>
        </Pressable>
      </View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ padding: 16, gap: 10 }}>
        <StatusPill status={status} />
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
          <Text style={[ui.title, { fontSize: 20 }]}>NIFTY {formatNumber(spot)}</Text>
          <Change abs={change(nifty)} pct={changePct(nifty)} style={{ fontSize: 13 }} />
        </View>
        <Segmented
          options={expiries.map((e) => ({ label: shortDate(e), value: e }))}
          value={active}
          onChange={setExpiry}
        />
        <Text style={ui.muted}>
          Lot size {NIFTY_LOT_SIZE} · Tap a premium to trade · Prices are model-derived (Black-Scholes)
        </Text>
      </View>
      <View style={[s.row, s.head]}>
        <Text style={[s.headText, { flex: 1 }]}>CALLS</Text>
        <Text style={[s.headText, { width: 90 }]}>STRIKE</Text>
        <Text style={[s.headText, { flex: 1 }]}>PUTS</Text>
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r) => String(r.strike)}
        renderItem={renderRow}
        getItemLayout={(_, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index })}
        initialScrollIndex={CHAIN_WIDTH - 3} // open with the ATM strike in view
      />
    </View>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    height: ROW_HEIGHT,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  atmRow: { borderBottomColor: colors.accent, borderBottomWidth: 1.5 },
  head: { height: 36, alignItems: 'center', backgroundColor: colors.card },
  headText: { color: colors.muted, fontSize: 12, fontWeight: '700', textAlign: 'center' },
  cell: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  itm: { backgroundColor: 'rgba(245, 158, 11, 0.08)' },
  strike: { width: 90, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card },
  strikeText: { color: colors.text, fontWeight: '700', fontVariant: ['tabular-nums'] },
  price: { color: colors.text, fontWeight: '600', fontVariant: ['tabular-nums'] },
  sub: { color: colors.muted, fontSize: 11, marginTop: 2 },
});
