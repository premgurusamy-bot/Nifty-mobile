import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { isIPv4 } from '../../server/preflight.ts';
import { isLocalApi } from '../api/localApi';
import { PreflightList, type PreflightView } from '../components/engine';
import { CATALOG, catalogEntry, sessionLabel } from '../lib/engine/catalog';
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
  | 'underlyingSecurityId'
  | 'pointValue'
  | 'tickSize'
  | 'maxLots'
  | 'rollDays';

/** Strategy / discipline settings — shared by every instrument. */
const ENGINE_FIELDS: [NumKey, string][] = [
  ['confHigh', 'High confidence threshold (trade)'],
  ['confWatch', 'Watch threshold (wait for confirmation)'],
  ['rrTarget', 'Risk:Reward target'],
  ['maxRisk', 'Max risk per trade (₹)'],
  ['atrMult', 'ATR multiplier for stop loss'],
  ['maxTradesPerDay', 'Daily trade limit'],
  ['maxDailyLoss', 'Daily max loss (₹, 0 = no limit)'],
  ['refreshSeconds', 'Auto-refresh interval (sec, min 15)'],
];

/** Contract settings — loaded from the catalog when you pick an instrument, editable. */
const OPTION_FIELDS: [NumKey, string][] = [
  ['lotSize', 'Lot size (units per lot)'],
  ['strikeInterval', 'Strike interval (points)'],
  ['maxLots', 'Max lots per trade (0 = no cap)'],
  ['underlyingSecurityId', 'Index security id (Dhan)'],
];
const FUTURES_FIELDS: [NumKey, string][] = [
  ['pointValue', '₹ per 1.00 price move, per lot'],
  ['tickSize', 'Tick size'],
  ['maxLots', 'Max lots per trade (0 = no cap)'],
  ['rollDays', 'Roll to next month this many days before expiry'],
];
const FIELDS: [NumKey, string][] = [...ENGINE_FIELDS, ...OPTION_FIELDS, ...FUTURES_FIELDS];

const INDEXES = CATALOG.filter((c) => c.kind === 'INDEX_OPTIONS');
const MCX = CATALOG.filter((c) => c.kind === 'MCX_FUTURES');

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[s.chip, active && s.chipActive]}
    >
      <Text style={[s.chipText, active && { color: colors.text }]}>{label}</Text>
    </Pressable>
  );
}

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
  const [futId, setFutId] = useState('');
  const cfgKey = cfg ? JSON.stringify(cfg) : '';
  const [loadedKey, setLoadedKey] = useState('');
  if (cfg && cfgKey !== loadedKey) {
    setLoadedKey(cfgKey);
    setDraft(Object.fromEntries(FIELDS.map(([k]) => [k, String(cfg[k])])));
    setExpiry(cfg.expiry);
    setFutId(cfg.futSecurityId);
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

  const save = async (extra: Partial<EngineConfig> = {}, report: (m: string | null) => void = setCfgMsg) => {
    report(null);
    const patch: Partial<EngineConfig> = { expiry, ...extra };
    if (cfg && futId.trim() !== cfg.futSecurityId) {
      // Manual contract override: the engine uses this id until you clear it (then it auto-resolves again).
      Object.assign(patch, {
        futSecurityId: futId.trim(),
        futExpiry: '',
        futTradingSymbol: futId.trim() ? `${cfg.symbol} (id ${futId.trim()})` : '',
      });
    }
    for (const [k] of FIELDS) {
      const n = Number(draft[k]);
      if (!Number.isFinite(n)) return report(`Invalid number for ${k}`);
      (patch as Record<string, number>)[k] = n;
    }
    try {
      await updateConfig(patch);
      report('Saved');
    } catch (e) {
      report((e as Error).message);
    }
  };

  const [instMsg, setInstMsg] = useState<string | null>(null);
  const cur = cfg ? catalogEntry(cfg.symbol) : null;
  const isFut = cfg?.instrumentKind === 'MCX_FUTURES';
  const pick = (symbol: string) => {
    if (!cfg || symbol === cfg.symbol) return;
    setInstMsg(null);
    updateConfig({ symbol })
      .then(() => setInstMsg(null))
      .catch((e) => setInstMsg((e as Error).message));
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

        {cfg ? (
          <Card style={{ gap: 12 }}>
            <Text style={[ui.sectionTitle, { marginTop: 0 }]}>Instrument</Text>
            <Text style={s.label}>Index options (the Excel option-buying system)</Text>
            <View style={s.chips}>
              {INDEXES.map((c) => (
                <Chip key={c.symbol} label={c.label} active={cfg.symbol === c.symbol} onPress={() => pick(c.symbol)} />
              ))}
            </View>
            <Text style={s.label}>MCX futures — mini contracts (long / short)</Text>
            <View style={s.chips}>
              {MCX.map((c) => (
                <Chip key={c.symbol} label={c.label} active={cfg.symbol === c.symbol} onPress={() => pick(c.symbol)} />
              ))}
            </View>
            {cur ? (
              <Text style={ui.muted}>
                {cur.label} · {cur.kind === 'MCX_FUTURES' ? 'futures' : 'options'} · {cur.unit} ·{' '}
                {sessionLabel(cur.session)}
              </Text>
            ) : null}
            {isFut ? (
              <View style={{ gap: 4 }}>
                <Text style={s.label}>Current contract</Text>
                <Text style={ui.title}>
                  {cfg.futTradingSymbol || 'Resolved on the next refresh from Dhan’s instrument list'}
                </Text>
                {cfg.futSecurityId ? (
                  <Text style={ui.muted}>
                    Security id {cfg.futSecurityId}
                    {cfg.futExpiry ? ` · expiry ${cfg.futExpiry}` : ''} · quantity is sent in lots
                  </Text>
                ) : null}
              </View>
            ) : (
              <Field
                label="Expiry (YYYY-MM-DD, blank = nearest)"
                value={expiry}
                onChange={setExpiry}
                keyboard="default"
              />
            )}
            {(isFut ? FUTURES_FIELDS : OPTION_FIELDS).map(([k, label]) => (
              <Field
                key={k}
                label={label}
                value={draft[k] ?? ''}
                onChange={(v) => setDraft((d) => ({ ...d, [k]: v }))}
              />
            ))}
            {isFut ? (
              <Field
                label="Contract security id (optional — only if auto-resolve fails)"
                value={futId}
                onChange={setFutId}
                keyboard="decimal-pad"
              />
            ) : null}
            <Text style={[ui.muted, { fontSize: 12 }]}>
              Values come from the instrument list above when you pick it; check them against the exchange
              {isFut ? ' (MCX contract specs)' : ' (NSE lot sizes change)'} and edit if needed. Switching is blocked
              while a trade or entry order is open; each instrument keeps its own IV history.
            </Text>
            {instMsg ? <Text style={{ color: instMsg === 'Saved' ? colors.up : colors.down }}>{instMsg}</Text> : null}
            <Button label="Save instrument settings" onPress={() => void save({}, setInstMsg)} />
          </Card>
        ) : null}

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
            {ENGINE_FIELDS.map(([k, label]) => (
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
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.cardAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.muted, fontWeight: '600', fontSize: 13 },
});
