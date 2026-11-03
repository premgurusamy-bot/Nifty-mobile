import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { isIPv4 } from '../../server/preflight.ts';
import { isLocalApi } from '../api/localApi';
import { PreflightList, type PreflightView } from '../components/engine';
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
  const { snap, updateConfig, preflight } = useEngine();

  const [clientId, setClientId] = useState('');
  const [token, setToken] = useState('');
  const [directMsg, setDirectMsg] = useState<string | null>(null);
  const [directBusy, setDirectBusy] = useState(false);

  const saveDirect = async () => {
    setDirectBusy(true);
    setDirectMsg(null);
    try {
      const nifty = await settings.saveDirect(clientId, token);
      setDirectMsg(`Saved on this phone · Dhan connected · NIFTY ${nifty}`);
      setToken('');
      setClientId('');
    } catch (e) {
      setDirectMsg(`Failed: ${(e as Error).message}`);
    } finally {
      setDirectBusy(false);
    }
  };

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

  const [ip, setIp] = useState(settings.staticIp);
  const [ipMsg, setIpMsg] = useState<string | null>(null);
  const [ipBusy, setIpBusy] = useState(false);
  const [pf, setPf] = useState<PreflightView | null>(null);
  const [pfBusy, setPfBusy] = useState(false);
  const [pfErr, setPfErr] = useState<string | null>(null);

  const saveIp = async () => {
    setIpMsg(null);
    if (ip.trim() && !isIPv4(ip)) return setIpMsg(`Failed: "${ip}" is not an IPv4 address (like 203.0.113.7)`);
    await settings.saveStaticIp(ip);
    setIpMsg(ip.trim() ? 'Saved on this phone' : 'Cleared');
  };

  const registerIp = async () => {
    setIpBusy(true);
    setIpMsg(null);
    try {
      if (!isIPv4(ip)) throw new Error(`"${ip}" is not an IPv4 address`);
      await settings.saveStaticIp(ip);
      const api = settings.api;
      if (!isLocalApi(api)) throw new Error('Connect your Dhan account above first');
      const ips = await api.registerStaticIp(ip.trim());
      setIpMsg(`Registered with Dhan · whitelisted: ${ips.join(', ') || '—'}`);
    } catch (e) {
      setIpMsg(`Failed: ${(e as Error).message}`);
    } finally {
      setIpBusy(false);
    }
  };

  const runCheck = async () => {
    setPfBusy(true);
    setPfErr(null);
    try {
      if (ip.trim() !== settings.staticIp) await settings.saveStaticIp(ip);
      setPf(await preflight());
    } catch (e) {
      setPfErr((e as Error).message);
    } finally {
      setPfBusy(false);
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
          <Text style={[ui.sectionTitle, { marginTop: 0 }]}>Dhan account (this phone)</Text>
          <Text style={ui.muted}>
            {settings.directClientId
              ? `Saved · client ${settings.directClientId.replace(/.(?=.{3})/g, '•')}${
                  settings.connection === 'DIRECT'
                    ? ' · in use (live data on this phone)'
                    : settings.connection === 'SERVER'
                      ? ' · not in use while a server is connected'
                      : ' · connecting…'
                }`
              : 'Enter your Dhan client id and access token to get live data straight from Dhan — no server needed.'}
          </Text>
          <Text style={ui.muted}>
            Stored only on this phone{Platform.OS === 'web' ? '' : ', encrypted in the Android Keystore'}. The engine,
            live data, journal and trading run on the phone while the app is open. LIVE orders also need your static IP
            (below) and a passing pre-flight check.
          </Text>
          <Field label="Dhan client id" value={clientId} onChange={setClientId} keyboard="default" />
          <Field label="Dhan access token" value={token} onChange={setToken} keyboard="default" secure />
          {directMsg ? (
            <Text style={{ color: directMsg.startsWith('Failed') ? colors.down : colors.up }}>{directMsg}</Text>
          ) : null}
          <Button
            label={directBusy ? 'Checking with Dhan…' : settings.directClientId ? 'Update & test' : 'Save & test'}
            onPress={saveDirect}
            disabled={directBusy || !clientId || !token}
          />
          {settings.directClientId ? (
            <Button
              label="Remove from this phone"
              color={colors.cardAlt}
              onPress={() => {
                setDirectMsg(null);
                void settings.clearDirect();
              }}
            />
          ) : null}
        </Card>

        <Card style={{ gap: 12 }}>
          <Text style={[ui.sectionTitle, { marginTop: 0 }]}>Static IP (for LIVE orders)</Text>
          <Text style={ui.muted}>
            Dhan accepts orders only from the static IP whitelisted on your account. For LIVE trading this phone must be
            online through that IP — your static-IP Wi-Fi, or a dedicated-IP VPN on the phone. Market data works from
            any network.
          </Text>
          <Field label="Static IP (IPv4)" value={ip} onChange={setIp} keyboard="decimal-pad" />
          {ipMsg ? <Text style={{ color: ipMsg.startsWith('Failed') ? colors.down : colors.up }}>{ipMsg}</Text> : null}
          <Button label="Save" onPress={() => void saveIp()} />
          <Button
            label={ipBusy ? 'Registering…' : 'Register with Dhan (primary IP)'}
            color={colors.cardAlt}
            onPress={() => void registerIp()}
            disabled={ipBusy || !ip.trim() || settings.connection !== 'DIRECT'}
          />
          <Text style={[ui.muted, { fontSize: 12 }]}>
            Registering replaces the primary IP on your Dhan account. Dhan may limit how often it can be changed.
          </Text>
          {cfg ? (
            <>
              <Text style={s.label}>Live order product</Text>
              <Segmented
                options={[
                  { label: 'Intraday', value: 'INTRADAY' as const },
                  { label: 'Carry forward (NRML)', value: 'MARGIN' as const },
                ]}
                value={cfg.liveProduct}
                onChange={(v) => void updateConfig({ liveProduct: v }).catch((e) => setIpMsg(`Failed: ${e.message}`))}
              />
            </>
          ) : null}
        </Card>

        <Card style={{ gap: 12 }}>
          <Text style={[ui.sectionTitle, { marginTop: 0 }]}>Pre-flight check</Text>
          <Text style={ui.muted}>
            Runs automatically before switching to LIVE. Checks the token, live data, option chain + Greeks, funds, your
            static IP, that this phone is actually online through it, that Dhan has it whitelisted, and market hours.
          </Text>
          <Button
            label={pfBusy ? 'Checking…' : 'Run pre-flight check'}
            onPress={() => void runCheck()}
            disabled={pfBusy || settings.connection !== 'DIRECT'}
          />
          {settings.connection !== 'DIRECT' ? (
            <Text style={ui.muted}>Connect your Dhan account above first.</Text>
          ) : null}
          {pfErr ? <Text style={{ color: colors.down }}>{pfErr}</Text> : null}
          {pf ? <PreflightList result={pf} /> : null}
        </Card>

        {cfg ? (
          <Card style={{ gap: 12 }}>
            <Text style={[ui.sectionTitle, { marginTop: 0 }]}>
              Engine settings {snap?.demo ? '(demo)' : settings.connection === 'DIRECT' ? '(this phone)' : '(server)'}
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
