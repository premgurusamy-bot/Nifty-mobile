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
      <Text style={[ui.sectionTitle, { marginTop: 0 }]}>Angel One (data for BANK NIFTY)</Text>
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
              <Text style={st.label}>Use Angel One data for BANK NIFTY (PAPER only for now)</Text>
              <Switch
                value={onBank}
                onValueChange={(v) =>
                  void run(async () => {
                    const rest = (cfg.angelSymbols ?? []).filter((x) => x !== 'BANKNIFTY');
                    await updateConfig({ angelSymbols: v ? [...rest, 'BANKNIFTY'] : rest });
                  })
                }
                accessibilityLabel="Use Angel One data for BANK NIFTY"
              />
            </View>
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
            With the switch on, BANK NIFTY&apos;s candles, option chain (prices, OI, IV, Greeks) and live quotes come
            from Angel One, so Dhan&apos;s option-chain limit is left to NIFTY. If Angel One isn&apos;t logged in or
            fails, BANK NIFTY uses Dhan for that refresh. Orders still go through Dhan, and BANK NIFTY can&apos;t trade
            LIVE while on Angel One data (PAPER only for now). Angel&apos;s sessions end each day: log in once each
            morning. &quot;Change in OI&quot; counts from the first quote the app saw today.
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
