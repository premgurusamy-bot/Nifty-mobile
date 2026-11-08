import { useState } from 'react';
import { StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useAngel } from '../state/AngelContext';
import { useEngine } from '../state/EngineContext';
import { colors } from '../theme';
import { Button, Card, styles as ui } from './ui';

function Input(p: { label: string; value: string; onChange: (v: string) => void; secure?: boolean; numeric?: boolean }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={st.label}>{p.label}</Text>
      <TextInput
        style={st.input}
        value={p.value}
        onChangeText={p.onChange}
        secureTextEntry={p.secure}
        keyboardType={p.numeric ? 'number-pad' : 'default'}
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={colors.muted}
        accessibilityLabel={p.label}
      />
    </View>
  );
}

const time = (ms: number | null) => (ms ? new Date(ms).toLocaleTimeString() : '—');

/** Settings card: Angel One as the market-data feed for BANK NIFTY (PAPER for now). */
export function AngelSettingsCard() {
  const a = useAngel();
  const { snap, updateConfig } = useEngine();
  const [apiKey, setApiKey] = useState('');
  const [code, setCode] = useState('');
  const [totpKey, setTotpKey] = useState('');
  const [pin, setPin] = useState('');
  const [editKeys, setEditKeys] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const cfg = snap?.config;
  const onBank = !!cfg?.angelSymbols?.includes('BANKNIFTY');
  const ordersBank = !!cfg?.angelOrderSymbols?.includes('BANKNIFTY');
  const toggle = (key: 'angelSymbols' | 'angelOrderSymbols', on: boolean) =>
    void run(async () => {
      const rest = (cfg?.[key] ?? []).filter((x) => x !== 'BANKNIFTY');
      await updateConfig({ [key]: on ? [...rest, 'BANKNIFTY'] : rest });
    });
  const feed = snap?.feeds?.BANKNIFTY;

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      if (r) setMsg(r);
    } catch (e) {
      setMsg(`Failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ gap: 12 }}>
      <Text style={[ui.sectionTitle, { marginTop: 0 }]}>Angel One (BANK NIFTY)</Text>
      {!a.available ? (
        <Text style={ui.muted}>Connect your Dhan account on this phone first — Angel One runs alongside it.</Text>
      ) : (
        <>
          <Text style={{ color: a.status?.connected ? colors.up : colors.muted, fontWeight: '600' }}>
            {a.status?.connected
              ? `Logged in as ${a.status.clientCode} since ${time(a.status.since)}`
              : a.hasKeys
                ? `Not logged in (${a.clientCode})`
                : 'Not set up'}
          </Text>
          {a.status?.error ? <Text style={{ color: colors.down }}>Last Angel One error: {a.status.error}</Text> : null}

          {!a.hasKeys || editKeys ? (
            <>
              <Text style={ui.muted}>
                One-time setup, from smartapi.angelone.in (your SmartAPI app) and Angel One&apos;s TOTP setup. Saved
                only on this phone, in secure storage.
              </Text>
              <Input label="SmartAPI API key" value={apiKey} onChange={setApiKey} secure />
              <Input label="Angel One client code" value={code} onChange={setCode} />
              <Input label="TOTP key (the code under the QR, or the otpauth:// link)" value={totpKey} onChange={setTotpKey} secure />
              <Button
                label="Save Angel One keys"
                disabled={busy}
                onPress={() =>
                  void run(async () => {
                    await a.saveKeys(apiKey, code, totpKey);
                    setApiKey('');
                    setTotpKey('');
                    setEditKeys(false);
                    return 'Saved';
                  })
                }
              />
            </>
          ) : null}

          {a.hasKeys && !a.status?.connected ? (
            <>
              <Input label="Angel One MPIN" value={pin} onChange={setPin} secure numeric />
              <Button
                label={busy ? 'Logging in…' : 'Log in to Angel One'}
                disabled={busy || !pin}
                onPress={() =>
                  void run(async () => {
                    await a.login(pin);
                    setPin('');
                    return 'Logged in';
                  })
                }
              />
            </>
          ) : null}

          {cfg ? (
            <View style={st.row}>
              <Text style={st.label}>Use Angel One data for BANK NIFTY</Text>
              <Switch
                value={onBank}
                onValueChange={(v) => toggle('angelSymbols', v)}
                accessibilityLabel="Use Angel One data for BANK NIFTY"
              />
            </View>
          ) : null}
          {cfg ? (
            <View style={st.row}>
              <Text style={st.label}>Place BANK NIFTY LIVE orders through Angel One (NIFTY stays with Dhan)</Text>
              <Switch
                value={ordersBank}
                onValueChange={(v) => toggle('angelOrderSymbols', v)}
                accessibilityLabel="Place BANK NIFTY orders through Angel One"
              />
            </View>
          ) : null}
          {cfg ? (
            <View style={st.row}>
              <Text style={st.label}>Never miss an entry: switch to the other broker when one can&apos;t take it</Text>
              <Switch
                value={cfg.brokerFailover !== false}
                onValueChange={(v) => void run(() => updateConfig({ brokerFailover: v }))}
                accessibilityLabel="Switch broker automatically"
              />
            </View>
          ) : null}
          {ordersBank && !a.status?.connected ? (
            <Text style={{ color: colors.down }}>
              Not logged in to Angel One:{' '}
              {cfg?.brokerFailover !== false ? 'BANK NIFTY entries go to Dhan until you log in.' : 'BANK NIFTY LIVE entries will fail.'}
            </Text>
          ) : null}
          {onBank && feed ? (
            <Text style={{ color: feed.feed === 'ANGEL' ? colors.up : colors.down }}>
              BANK NIFTY data now: {feed.feed === 'ANGEL' ? 'Angel One' : feed.note ?? 'Dhan'}
            </Text>
          ) : null}

          {a.status?.connected ? (
            <>
              <Button label={busy ? 'Testing…' : 'Test Angel One data'} disabled={busy} onPress={() => void run(a.test)} />
              <Button label="Log out of Angel One" color={colors.cardAlt} disabled={busy} onPress={() => void run(a.logout)} />
            </>
          ) : null}
          {a.hasKeys && !editKeys ? (
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Button label="Change keys" color={colors.cardAlt} onPress={() => setEditKeys(true)} />
              </View>
              <View style={{ flex: 1 }}>
                <Button label="Forget keys" color={colors.cardAlt} disabled={busy} onPress={() => void run(a.forgetKeys)} />
              </View>
            </View>
          ) : null}
          <Text style={[ui.muted, { fontSize: 12 }]}>
            Data: BANK NIFTY&apos;s candles, option chain (prices, OI, IV, Greeks) and live quotes come from Angel
            One, so Dhan&apos;s option-chain limit is left to NIFTY. If one broker&apos;s data fails, that refresh
            uses the other. Orders: BANK NIFTY&apos;s entry, its stop-loss and every exit go to Angel One (a trade
            always stays with the broker that opened it). With &quot;never miss an entry&quot; on, an entry Angel One
            certainly didn&apos;t take — not logged in, refused, rejected, or not filled in the fill window and
            cancelled — is placed with Dhan at once (and NIFTY the other way round). If it is unclear whether an order
            went through (no reply), it does not switch, so you never get two orders. Angel One orders need your
            static IP registered on the SmartAPI app (the same as Dhan&apos;s). Angel&apos;s sessions end each day:
            log in each morning. &quot;Change in OI&quot; counts from the first quote the app saw today.
          </Text>
        </>
      )}
      {msg ? <Text style={{ color: msg.startsWith('Failed') ? colors.down : colors.up }}>{msg}</Text> : null}
    </Card>
  );
}

const st = StyleSheet.create({
  label: { color: colors.muted, fontSize: 13, flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  input: {
    backgroundColor: colors.cardAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
});
