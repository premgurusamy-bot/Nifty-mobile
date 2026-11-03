import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { Button, Card, Segmented, styles as ui } from '../components/ui';
import type { EngineConfig } from '../lib/engine/types';
import { useEngine } from '../state/EngineContext';
import { useSettings } from '../state/SettingsContext';
import { colors } from '../theme';

type NumKey =
  | 'confHigh'
  | 'confWatch'
  | 'rrTarget'
  | 'maxRisk'
  | 'lotSize'
  | 'atrMult'
  | 'maxTradesPerDay'
  | 'maxDailyLoss'
  | 'refreshSeconds'
  | 'strikeInterval'
  | 'underlyingSecurityId';

const FIELDS: [NumKey, string][] = [
  ['confHigh', 'High confidence threshold (trade)'],
  ['confWatch', 'Watch threshold (wait for confirmation)'],
  ['rrTarget', 'Risk:Reward target'],
  ['maxRisk', 'Max risk per trade (₹)'],
  ['lotSize', 'Lot size'],
  ['atrMult', 'ATR multiplier for stop loss'],
  ['maxTradesPerDay', 'Daily trade limit'],
  ['maxDailyLoss', 'Daily max loss (₹, 0 = no limit)'],
  ['refreshSeconds', 'Auto-refresh interval (sec, min 15)'],
  ['strikeInterval', 'Strike interval (points)'],
  ['underlyingSecurityId', 'Underlying security id'],
];

function Field({
  label,
  value,
  onChange,
  keyboard = 'decimal-pad',
  secure,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  keyboard?: 'decimal-pad' | 'default' | 'url';
  secure?: boolean;
}) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        style={s.input}
        value={value}
        onChangeText={onChange}
        keyboardType={keyboard}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={secure}
        placeholderTextColor={colors.muted}
      />
    </View>
  );
}

export default function SettingsScreen() {
  const settings = useSettings();
  const { snap, updateConfig, mode } = useEngine();

  const [url, setUrl] = useState(settings.serverUrl);
  const [key, setKey] = useState('');
  const [connMsg, setConnMsg] = useState<string | null>(null);
  const [connBusy, setConnBusy] = useState(false);

  const cfg = snap?.config;
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [expiry, setExpiry] = useState('');
  const [cfgMsg, setCfgMsg] = useState<string | null>(null);

  // Reload the form only when the saved settings change — the server sends a fresh
  // config object every poll, which must not wipe edits in progress.
  const cfgKey = cfg ? JSON.stringify(cfg) : '';
  const [loadedKey, setLoadedKey] = useState('');
  if (cfg && cfgKey !== loadedKey) {
    setLoadedKey(cfgKey);
    setDraft(Object.fromEntries(FIELDS.map(([k]) => [k, String(cfg[k])])));
    setExpiry(cfg.expiry);
  }

  const connect = async () => {
    setConnBusy(true);
    setConnMsg(null);
    try {
      const st = await settings.connect(url, key);
      setConnMsg(
        `Connected · client ${st.clientId} · live orders ${st.liveOrders ? 'ENABLED' : 'disabled'}${st.error ? ` · ${st.error}` : ''}`,
      );
      setKey('');
    } catch (e) {
      setConnMsg(`Failed: ${(e as Error).message}`);
    } finally {
      setConnBusy(false);
    }
  };

  const save = async (extra: Partial<EngineConfig> = {}) => {
    setCfgMsg(null);
    const patch: Partial<EngineConfig> = { expiry, ...extra };
    for (const [k] of FIELDS) {
      const n = Number(draft[k]);
      if (!Number.isFinite(n)) return setCfgMsg(`Invalid number for ${k}`);
      (patch as Record<string, number>)[k] = n;
    }
    try {
      await updateConfig(patch);
      setCfgMsg('Saved');
    } catch (e) {
      setCfgMsg((e as Error).message);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
        <Card style={{ gap: 12 }}>
          <Text style={[ui.sectionTitle, { marginTop: 0 }]}>Dhan server</Text>
          <Text style={ui.muted}>
            {mode === 'DHAN'
              ? `Connected to ${settings.serverUrl}${settings.server ? ` · client ${settings.server.clientId}` : ''}`
              : 'Not connected — the app is running the engine in DEMO mode on simulated data.'}
          </Text>
          <Text style={ui.muted}>
            Your Dhan client id and access token live only on your server (see README → Server setup). The app stores
            just the server URL and its access key{Platform.OS === 'web' ? '' : ' (in the device keychain)'}.
          </Text>
          <Field label="Server URL" value={url} onChange={setUrl} keyboard="url" />
          <Field label="Server access key (APP_API_KEY)" value={key} onChange={setKey} keyboard="default" secure />
          {connMsg ? (
            <Text style={{ color: connMsg.startsWith('Failed') ? colors.down : colors.up }}>{connMsg}</Text>
          ) : null}
          <Button
            label={connBusy ? 'Connecting…' : 'Save & test connection'}
            onPress={connect}
            disabled={connBusy || !url || !key}
          />
          {mode === 'DHAN' ? (
            <Button label="Disconnect (use demo)" color={colors.cardAlt} onPress={() => void settings.disconnect()} />
          ) : null}
        </Card>

        {cfg ? (
          <Card style={{ gap: 12 }}>
            <Text style={[ui.sectionTitle, { marginTop: 0 }]}>
              Engine settings {snap?.demo ? '(demo)' : '(server)'}
            </Text>
            <Text style={s.label}>Underlying</Text>
            <Segmented
              options={['NIFTY', 'BANKNIFTY', 'FINNIFTY'].map((v) => ({ label: v, value: v }))}
              value={cfg.symbol}
              onChange={(v) => void updateConfig({ symbol: v }).catch((e) => setCfgMsg(e.message))}
            />
            <Text style={ui.muted}>
              Presets fill security id / segment / strike interval (13·IDX_I·50, 25·IDX_I·100, 27·IDX_I·50). Set the lot
              size for the index you choose.
            </Text>
            <Field
              label="Expiry (YYYY-MM-DD, blank = nearest)"
              value={expiry}
              onChange={setExpiry}
              keyboard="default"
            />
            {FIELDS.map(([k, label]) => (
              <Field
                key={k}
                label={label}
                value={draft[k] ?? ''}
                onChange={(v) => setDraft((d) => ({ ...d, [k]: v }))}
              />
            ))}
            <View style={s.switchRow}>
              <Text style={s.label}>Alerts enabled (Telegram on the server)</Text>
              <Switch value={cfg.alertsEnabled} onValueChange={(v) => void updateConfig({ alertsEnabled: v })} />
            </View>
            {cfgMsg ? <Text style={{ color: cfgMsg === 'Saved' ? colors.up : colors.down }}>{cfgMsg}</Text> : null}
            <Button label="Save engine settings" onPress={() => void save()} />
          </Card>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  label: { color: colors.muted, fontSize: 12 },
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
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
