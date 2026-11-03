import { router, useIsFocused } from 'expo-router';
import { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Change, Segmented, StatusPill, styles as ui } from '../../components/ui';
import { formatNumber } from '../../lib/format';
import { NIFTY_ID, niftyLotSize } from '../../lib/instruments';
import { atmStrike, buildChain, type ChainRow } from '../../lib/optionChain';
import { change, changePct } from '../../lib/simulator';
import { upcomingExpiries } from '../../lib/time';
import { useMarket } from '../../state/MarketContext';
import { useSettings } from '../../state/SettingsContext';
import { colors } from '../../theme';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (iso: string) => {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
};

const CHAIN_WIDTH = 10;
const ROW_HEIGHT = 54;

const CHAIN_POLL_MS = 3000; // Dhan allows 1 option-chain request per 3 s

const compact = (n: number) =>
  n >= 1e7 ? `${(n / 1e7).toFixed(2)}Cr` : n >= 1e5 ? `${(n / 1e5).toFixed(1)}L` : String(n);

/** Live chain from the server (Dhan) or the local Black-Scholes model in demo mode. */
function useChain(expiry: string | null) {
  const { api } = useSettings();
  const { spot, now, seedPrices } = useMarket();
  const focused = useIsFocused();
  const [expiries, setExpiries] = useState<string[]>([]);
  const [live, setLive] = useState<{ spot: number; rows: ChainRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    api
      .expiries()
      .then((r) => setExpiries(r.expiries.slice(0, 3)))
      .catch((e) => setError(e.message));
  }, [api]);

  const active = api ? (expiry && expiries.includes(expiry) ? expiry : (expiries[0] ?? null)) : null;
  useEffect(() => {
    if (!api || !active || !focused) return;
    let alive = true;
    const pull = () =>
      api
        .optionChain(active)
        .then((r) => {
          if (!alive) return;
          setLive(r);
          setError(null);
          const prices: Record<string, number> = {};
          for (const row of r.rows) {
            prices[row.ce.id] = row.ce.ltp;
            prices[row.pe.id] = row.pe.ltp;
          }
          seedPrices(prices);
        })
        .catch((e) => alive && setError(e.message));
    pull();
    const t = setInterval(pull, CHAIN_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [api, active, focused, seedPrices]);

  if (api) return { expiries, active, spot: live?.spot || spot, rows: live?.rows ?? [], error, live: true };
  const local = upcomingExpiries(now, 3);
  const a = expiry && local.includes(expiry) ? expiry : local[0];
  return { expiries: local, active: a, spot, rows: buildChain(spot, a, now, CHAIN_WIDTH), error: null, live: false };
}

const openTicket = (id: string) => router.push({ pathname: '/order', params: { id, side: 'BUY' } });

export default function OptionChainScreen() {
  const { quotes, status, source } = useMarket();
  const [expiry, setExpiry] = useState<string | null>(null);
  const { expiries, active, spot, rows, error, live } = useChain(expiry);
  const atm = rows.length
    ? rows.reduce((b, r) => (Math.abs(r.strike - spot) < Math.abs(b.strike - spot) ? r : b)).strike
    : atmStrike(spot);
  const nifty = quotes[NIFTY_ID];

  const renderRow = ({ item }: { item: ChainRow }) => {
    const ceITM = item.strike < spot;
    const peITM = item.strike > spot;
    return (
      <View style={[s.row, item.strike === atm && s.atmRow]}>
        <Pressable style={[s.cell, ceITM && s.itm]} onPress={() => openTicket(item.ce.id)}>
          <Text style={s.price}>{formatNumber(item.ce.ltp)}</Text>
          <Text style={s.sub}>
            Δ {item.ce.delta.toFixed(2)}
            {item.ce.oi != null ? ` · OI ${compact(item.ce.oi)}` : ''}
          </Text>
        </Pressable>
        <View style={s.strike}>
          <Text style={s.strikeText}>{item.strike}</Text>
          <Text style={s.sub}>IV {(item.ce.iv * 100).toFixed(1)}</Text>
        </View>
        <Pressable style={[s.cell, peITM && s.itm]} onPress={() => openTicket(item.pe.id)}>
          <Text style={s.price}>{formatNumber(item.pe.ltp)}</Text>
          <Text style={s.sub}>
            Δ {item.pe.delta.toFixed(2)}
            {item.pe.oi != null ? ` · OI ${compact(item.pe.oi)}` : ''}
          </Text>
        </Pressable>
      </View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ padding: 16, gap: 10 }}>
        <StatusPill status={status} live={source === 'DHAN'} />
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
          <Text style={[ui.title, { fontSize: 20 }]}>NIFTY {formatNumber(spot)}</Text>
          <Change abs={change(nifty)} pct={changePct(nifty)} style={{ fontSize: 13 }} />
        </View>
        {expiries.length ? (
          <Segmented
            options={expiries.map((e) => ({ label: shortDate(e), value: e }))}
            value={active ?? expiries[0]}
            onChange={setExpiry}
          />
        ) : null}
        <Text style={ui.muted}>
          Lot size {niftyLotSize()} · Tap a premium to trade ·{' '}
          {live ? 'Live Dhan option chain (refreshes every 3 s)' : 'Demo prices are model-derived (Black-Scholes)'}
        </Text>
        {error ? <Text style={{ color: colors.down }}>{error}</Text> : null}
      </View>
      <View style={[s.row, s.head]}>
        <Text style={[s.headText, { flex: 1 }]}>CALLS</Text>
        <Text style={[s.headText, { width: 90 }]}>STRIKE</Text>
        <Text style={[s.headText, { flex: 1 }]}>PUTS</Text>
      </View>
      <FlatList
        key={`${active}-${rows.length > 0}`}
        data={rows}
        keyExtractor={(r) => String(r.strike)}
        renderItem={renderRow}
        getItemLayout={(_, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index })}
        // open with the ATM strike in view
        initialScrollIndex={
          rows.length > CHAIN_WIDTH ? Math.max(0, rows.findIndex((r) => r.strike === atm) - 3) : undefined
        }
        ListEmptyComponent={
          live && !error ? <Text style={[ui.muted, { padding: 16 }]}>Loading option chain…</Text> : undefined
        }
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
