import { useState } from 'react';
import { StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useAngel } from '../state/AngelContext';
import { useEngine } from '../state/EngineContext';
import { colors } from '../theme';
import { Button, Card, Segmented, styles as ui } from './ui';
import { ScanQrButton } from './QrScanner';
import { otpauthInfo, parseTotpKey } from '../lib/totp';

const INDEXES = [
  { sym: 'NIFTY', label: 'NIFTY 50' },
  { sym: 'BANKNIFTY', label: 'BANK NIFTY' },
  { sym: 'FINNIFTY', label: 'FIN NIFTY' },
];
const BROKERS = [
  { label: 'Dhan', value: 'DHAN' as const },
  { label: 'Angel One', value: 'ANGEL' as const },
];

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

/** Settings card: Angel One login, and per index which broker gives the data and takes the orders. */
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
  const feeds = snap?.feeds;
  const anyAngelOrders = (cfg?.angelOrderSymbols ?? []).length > 0;
  const setFor = (key: 'angelSymbols' | 'angelOrderSymbols', sym: string, on: boolean) =>
    void run(async () => {
      const rest = (cfg?.[key] ?? []).filter((x) => x !== sym);
      await updateConfig({ [key]: on ? [...rest, sym] : rest });
    });

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
      <Text style={[ui.sectionTitle, { marginTop: 0 }]}>Angel One · brokers per index</Text>
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
                One-time setup, from smartapi.angelone.in (your SmartAPI app) and Angel One&apos;s TOTP setup
                (smartapi.angelone.in/enable-totp — tap Scan QR code and point the camera at the QR, or pick a
                screenshot of it). Saved only on this phone, in secure storage.
              </Text>
              <Input label="SmartAPI API key (the API key, not the secret key)" value={apiKey} onChange={setApiKey} secure />
              <Input label="Angel One client code" value={code} onChange={setCode} />
              <Input label="TOTP key (the code under the QR, or the otpauth:// link)" value={totpKey} onChange={setTotpKey} secure />
              <ScanQrButton
                title="Scan Angel One's TOTP QR code"
                onScan={(data) => {
                  try {
                    parseTotpKey(data);
                  } catch (e) {
                    setMsg(`Failed: that QR isn't a TOTP setup code (${(e as Error).message})`);
                    return;
                  }
                  setTotpKey(data);
                  const acc = otpauthInfo(data)?.account ?? '';
                  if (!code.trim() && /^[A-Za-z0-9]{4,}$/.test(acc)) setCode(acc.toUpperCase());
                  setMsg('TOTP key scanned');
                }}
              />
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
              <Button
                label="Check TOTP code"
                color={colors.cardAlt}
                onPress={() =>
                  void run(async () => {
                    const c = await a.currentCode();
                    if (!c) return 'No TOTP key saved';
                    return `The app's code now: ${c.code} (changes in ${c.secondsLeft} s) — it must match Angel One in your authenticator app. If it doesn't, the saved key is old: Change keys and scan Angel's newest QR.`;
                  })
                }
              />
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

          {cfg
            ? INDEXES.map(({ sym, label }) => (
                <View key={sym} style={{ gap: 6 }}>
                  <Text style={[st.label, { color: colors.text, fontWeight: '700' }]}>{label}</Text>
                  <View style={st.row}>
                    <Text style={[st.label, { width: 56 }]}>Data</Text>
                    <View style={{ flex: 1 }}>
                      <Segmented
                        options={BROKERS}
                        value={cfg.angelSymbols?.includes(sym) ? 'ANGEL' : 'DHAN'}
                        onChange={(v) => setFor('angelSymbols', sym, v === 'ANGEL')}
                      />
                    </View>
                  </View>
                  <View style={st.row}>
                    <Text style={[st.label, { width: 56 }]}>Orders &amp; balance</Text>
                    <View style={{ flex: 1 }}>
                      <Segmented
                        options={BROKERS}
                        value={cfg.angelOrderSymbols?.includes(sym) ? 'ANGEL' : 'DHAN'}
                        onChange={(v) => setFor('angelOrderSymbols', sym, v === 'ANGEL')}
                      />
                    </View>
                  </View>
                  {feeds?.[sym] && (cfg.angelSymbols?.includes(sym) || feeds[sym].note) ? (
                    <Text style={{ fontSize: 12, color: feeds[sym].feed === 'ANGEL' ? colors.up : colors.down }}>
                      Data now: {feeds[sym].feed === 'ANGEL' ? 'Angel One' : feeds[sym].note ?? 'Dhan'}
                    </Text>
                  ) : null}
                </View>
              ))
            : null}
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
          {anyAngelOrders && !a.status?.connected ? (
            <Text style={{ color: colors.down }}>
              Not logged in to Angel One:{' '}
              {cfg?.brokerFailover !== false
                ? 'entries set to Angel One go to Dhan (sized on the Dhan balance) until you log in.'
                : 'LIVE entries set to Angel One will fail.'}
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
            Per index: Data = where its candles, option chain (prices, OI, IV, Greeks) and live quotes come
            from. Orders &amp; balance = where its LIVE entry, stop-loss and exits go, and whose available
            balance sizes it (Capital mode with live capital 0). A trade always stays with the broker that opened
            it. If one broker&apos;s data fails, that refresh uses the other. With &quot;never miss an entry&quot; on,
            an entry the chosen broker certainly didn&apos;t take — not logged in, refused, rejected, or not filled
            in the fill window and cancelled — goes to the other broker at once; if it&apos;s unclear whether an
            order went through, it doesn&apos;t switch, so you never get two orders. Orders at either broker need
            your static IP&apos;s network. Angel&apos;s sessions end each day: log in each morning. With Angel One
            data, &quot;change in OI&quot; counts from the first quote the app saw today.
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
