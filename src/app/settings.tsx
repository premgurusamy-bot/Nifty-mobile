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
import { formatINR } from '../lib/format';
import { lockedProfit } from '../lib/engine/profitLock';
import { AlertSettingsCard } from '../components/AlertSettings';
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
  | 'rollDays'
  | 'capitalPaper'
  | 'capitalLive'
  | 'capitalPct'
  | 'marginPerLot'
  | 'lockStart'
  | 'lockStep'
  | 'lockRideFrom'
  | 'lockRideAmount'
  | 'minPremium'
  | 'maxStopPct';

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
const SIZING_FIELDS: [NumKey, string][] = [
  ['capitalPaper', 'Paper trading capital (₹)'],
  ['capitalLive', 'Live trading capital (₹, 0 = Dhan available balance)'],
  ['capitalPct', 'Use this % of capital per trade (1–100)'],
  ['marginPerLot', 'MCX margin per lot (₹, 0 = estimate 12% of contract value)'],
];
const LOCK_FIELDS: [NumKey, string][] = [
  ['lockStart', 'Start locking at profit (₹)'],
  ['lockStep', 'Lock step (₹) — secured profit rises by this, one step behind'],
  ['lockRideFrom', 'Stop stepping at secured profit (₹, 0 = keep stepping)'],
  ['lockRideAmount', 'Above that, let this much ride from the peak (₹)'],
];
const CHEAP_FIELDS: [NumKey, string][] = [
  ['minPremium', 'Minimum option premium (₹, 0 = off)'],
  ['maxStopPct', 'Maximum stop-loss as % of premium (0 = off)'],
];
const FIELDS: [NumKey, string][] = [
  ...CHEAP_FIELDS,
  ...ENGINE_FIELDS,
  ...OPTION_FIELDS,
  ...FUTURES_FIELDS,
  ...SIZING_FIELDS,
  ...LOCK_FIELDS,
];
const PCTS = [25, 50, 75, 100];

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
  const [pin, setPin] = useState('');
  const [totpKey, setTotpKey] = useState('');
  const [changeKey, setChangeKey] = useState(false);
  const [method, setMethod] = useState<'PIN' | 'TOKEN'>('PIN');
  const [directMsg, setDirectMsg] = useState<string | null>(null);
  const [directBusy, setDirectBusy] = useState(false);
  // Prefill the client ID of the last account used on this phone.
  const [prefilled, setPrefilled] = useState(false);
  if (!prefilled && settings.loaded) {
    setPrefilled(true);
    if (settings.lastClientId) setClientId(settings.lastClientId);
  }
  const [relogin, setRelogin] = useState(false);
  const loggedIn = !!settings.directClientId;

  const doLogin = async () => {
    setDirectBusy(true);
    setDirectMsg(null);
    try {
      if (method === 'PIN' && totpKey.trim()) await settings.saveTotpKey(totpKey);
      const nifty = method === 'PIN' ? await settings.login(clientId, pin) : await settings.saveDirect(clientId, token);
      setTotpKey('');
      setChangeKey(false);
      setDirectMsg(`Logged in · Dhan connected · NIFTY ${nifty}`);
      setRelogin(false);
      setToken('');
      setPin('');
    } catch (e) {
      setDirectMsg(`Failed: ${(e as Error).message}`);
    } finally {
      setDirectBusy(false);
    }
  };

  const doLogout = async (forget = false) => {
    setDirectBusy(true);
    setDirectMsg(null);
    try {
      await (forget ? settings.clearDirect() : settings.logout());
      setDirectMsg(forget ? 'Logged out and removed from this phone' : 'Logged out · switched to PAPER');
      if (forget) setClientId('');
    } catch (e) {
      setDirectMsg(`Failed: ${(e as Error).message}`);
    } finally {
      setDirectBusy(false);
    }
  };

  const cfg = snap?.config;
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [expiry, setExpiry] = useState('');
  const [cutoff, setCutoff] = useState('');
  const [cutoffMcx, setCutoffMcx] = useState('');
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
    setCutoff(cfg.lastEntryTime ?? '');
    setCutoffMcx(cfg.lastEntryTimeMcx ?? '');
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
    const patch: Partial<EngineConfig> = { expiry, lastEntryTime: cutoff, lastEntryTimeMcx: cutoffMcx, ...extra };
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

  const [sizeMsg, setSizeMsg] = useState<string | null>(null);
  const [lockMsg, setLockMsg] = useState<string | null>(null);
  const lockDraft = {
    lockStart: Number(draft.lockStart),
    lockStep: Number(draft.lockStep),
    lockRideFrom: Number(draft.lockRideFrom),
    lockRideAmount: Number(draft.lockRideAmount),
  };
  const lockPreview = (() => {
    const { lockStart: a, lockStep: st, lockRideFrom: r, lockRideAmount: m } = lockDraft;
    if (!(a > 0) || !(st > 0)) return [];
    const peaks = new Set<number>([a, a + st, a + 2 * st]);
    if (r > 0 && m > 0) [r, r + st, r + m, r + m + st, r + m + 2 * st + 2000].forEach((x) => peaks.add(x));
    else [a + 3 * st, a + 5 * st].forEach((x) => peaks.add(x));
    return [...peaks].sort((x, y) => x - y).map((pk) => [pk, lockedProfit(pk, lockDraft) ?? 0] as const);
  })();
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
          {loggedIn && !relogin ? (
            <>
              <Text style={{ color: colors.up, fontWeight: '700' }}>
                Logged in · client {settings.directClientId.replace(/.(?=.{3})/g, '•')}
              </Text>
              <Text style={ui.muted}>
                {settings.connection === 'DIRECT'
                  ? 'In use — live data and trading on this phone.'
                  : settings.connection === 'SERVER'
                    ? 'Not in use while a server is connected.'
                    : 'Connecting…'}{' '}
                Dhan tokens last 24 hours; the app renews it while it can, otherwise log in again.
              </Text>
              <Button
                label="Log in again (new token)"
                onPress={() => {
                  setDirectMsg(null);
                  setClientId(settings.directClientId);
                  setRelogin(true);
                }}
                disabled={directBusy}
              />
              <Button
                label={directBusy ? 'Logging out…' : 'Log out'}
                color={colors.down}
                onPress={() => void doLogout()}
                disabled={directBusy}
              />
              <Button
                label="Log out and remove from this phone"
                color={colors.cardAlt}
                onPress={() => void doLogout(true)}
                disabled={directBusy}
              />
              <Text style={[ui.muted, { fontSize: 12 }]}>
                Log out switches the app to PAPER and turns automatic LIVE entries off. It is refused while a LIVE
                position is open — exit it first.
              </Text>
            </>
          ) : (
            <>
              <Segmented
                options={[
                  { label: 'Client ID + PIN', value: 'PIN' as const },
                  { label: 'Access token', value: 'TOKEN' as const },
                ]}
                value={method}
                onChange={setMethod}
              />
              <Field label="Dhan client ID" value={clientId} onChange={setClientId} keyboard="decimal-pad" />
              {method === 'PIN' ? (
                <>
                  <Field label="Dhan PIN (6 digits)" value={pin} onChange={setPin} keyboard="decimal-pad" secure />
                  {settings.hasTotpKey && !changeKey ? (
                    <Text style={[ui.muted, { fontSize: 12 }]}>
                      TOTP key saved on this phone — the app makes the login code itself.{' '}
                      <Text style={{ color: colors.accent, fontWeight: '700' }} onPress={() => setChangeKey(true)}>
                        Change key
                      </Text>
                    </Text>
                  ) : (
                    <>
                      <Field
                        label="Dhan TOTP key (one-time setup)"
                        value={totpKey}
                        onChange={setTotpKey}
                        keyboard="default"
                        secure
                      />
                      <Text style={[ui.muted, { fontSize: 12 }]}>
                        Once only: web.dhan.co → Profile → DhanHQ Trading APIs → Set up TOTP. Copy the key Dhan shows
                        (letters A–Z and digits 2–7) — or the otpauth:// link from its QR code — and paste it here.
                        After that you log in with just your client ID and PIN. The key is kept encrypted on this
                        phone; your PIN is not stored.
                      </Text>
                    </>
                  )}
                </>
              ) : (
                <>
                  <Field label="Dhan access token" value={token} onChange={setToken} keyboard="default" secure />
                  <Text style={[ui.muted, { fontSize: 12 }]}>
                    Generate it at web.dhan.co → Profile → DhanHQ Trading APIs (valid 24 hours).
                  </Text>
                </>
              )}
              <Button
                label={directBusy ? 'Logging in…' : 'Log in'}
                onPress={() => void doLogin()}
                disabled={
                  directBusy ||
                  !clientId ||
                  (method === 'PIN' ? !pin || (!settings.hasTotpKey && !totpKey.trim()) : !token)
                }
              />
              {relogin ? (
                <Button label="Cancel" color={colors.cardAlt} onPress={() => setRelogin(false)} disabled={directBusy} />
              ) : null}
              <Text style={[ui.muted, { fontSize: 12 }]}>
                Stored only on this phone{Platform.OS === 'web' ? '' : ', encrypted in the Android Keystore'}. Every
                login turns automatic LIVE entries off; logging in with a different Dhan account also switches to
                PAPER.
              </Text>
            </>
          )}
          {directMsg ? (
            <Text style={{ color: directMsg.startsWith('Failed') ? colors.down : colors.up }}>{directMsg}</Text>
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
            <Text style={[ui.sectionTitle, { marginTop: 0 }]}>Position size & capital</Text>
            <Segmented
              options={[
                { label: 'Risk per trade', value: 'RISK' as const },
                { label: 'Capital %', value: 'CAPITAL' as const },
              ]}
              value={cfg.sizingMode}
              onChange={(v) => void save({ sizingMode: v }, setSizeMsg)}
            />
            <Text style={ui.muted}>
              {cfg.sizingMode === 'CAPITAL'
                ? `Lots = capital × % ÷ cost of 1 lot (${isFut ? 'margin per lot' : 'premium × lot size'}). PAPER uses the paper capital, LIVE the live capital (or your Dhan balance). Max lots per trade still applies — set it to 0 for no cap.`
                : `Lots are sized so the stop-loss costs at most the max risk per trade (₹${cfg.maxRisk}). Switch to Capital % to size by money instead.`}
            </Text>
            {SIZING_FIELDS.filter(([k]) => isFut || k !== 'marginPerLot').map(([k, label]) => (
              <Field
                key={k}
                label={label}
                value={draft[k] ?? ''}
                onChange={(v) => setDraft((d) => ({ ...d, [k]: v }))}
              />
            ))}
            <View style={s.chips}>
              {PCTS.map((p) => (
                <Chip
                  key={p}
                  label={`${p}%`}
                  active={draft.capitalPct === String(p)}
                  onPress={() => setDraft((d) => ({ ...d, capitalPct: String(p) }))}
                />
              ))}
            </View>
            {snap?.capital ? (
              <Text style={ui.muted}>
                Now ({cfg.tradeMode}): {formatINR(snap.capital.capital, 0)} per trade — {formatINR(snap.capital.base, 0)}{' '}
                {snap.capital.source}
                {cfg.capitalPct < 100 ? ` × ${cfg.capitalPct}%` : ''}
              </Text>
            ) : null}
            {snap?.dashboard?.candidatePlan?.sizing ? (
              <Text style={ui.muted}>Next entry: {snap.dashboard.candidatePlan.sizing}</Text>
            ) : null}
            {sizeMsg ? <Text style={{ color: sizeMsg === 'Saved' ? colors.up : colors.down }}>{sizeMsg}</Text> : null}
            <Button label="Save capital settings" onPress={() => void save({}, setSizeMsg)} />
          </Card>
        ) : null}

        {cfg ? (
          <Card style={{ gap: 12 }}>
            <Text style={[ui.sectionTitle, { marginTop: 0 }]}>Profit lock (trailing ₹)</Text>
            <View style={s.switchRow}>
              <Text style={s.label}>Lock in profit as the trade moves in my favour</Text>
              <Switch
                value={cfg.profitLock}
                onValueChange={(v) => void save({ profitLock: v }, setLockMsg)}
                accessibilityLabel="Profit lock"
              />
            </View>
            <Text style={ui.muted}>
              Counts the whole trade&apos;s profit (including the half booked at Target 1). Once it reaches the start,
              the stop-loss moves up so that profit is secured — one step behind the best profit, so small dips
              don&apos;t exit. Target 1 still books half; Target 2 is off while this is on. In LIVE the stop order at
              Dhan is moved too. A fast gap can still fill worse than the locked amount.
            </Text>
            {LOCK_FIELDS.map(([k, label]) => (
              <Field
                key={k}
                label={label}
                value={draft[k] ?? ''}
                onChange={(v) => setDraft((d) => ({ ...d, [k]: v }))}
              />
            ))}
            {lockPreview.length ? (
              <View style={{ gap: 2 }}>
                <Text style={s.label}>Best profit reached → secured</Text>
                {lockPreview.map(([pk, lk]) => (
                  <Text key={pk} style={ui.muted}>
                    {formatINR(pk, 0)} → {formatINR(lk, 0)}
                  </Text>
                ))}
              </View>
            ) : null}
            {lockMsg ? <Text style={{ color: lockMsg === 'Saved' ? colors.up : colors.down }}>{lockMsg}</Text> : null}
            <Button label="Save profit lock" onPress={() => void save({}, setLockMsg)} />
          </Card>
        ) : null}

        <AlertSettingsCard />

        {cfg ? (
          <Card style={{ gap: 12 }}>
            <Text style={[ui.sectionTitle, { marginTop: 0 }]}>
              Engine settings {snap?.demo ? '(demo)' : settings.connection === 'DIRECT' ? '(this phone)' : '(server)'}
            </Text>
            <Field
              label="No new trades after (IST, HH:MM · NIFTY / BANK NIFTY / FIN NIFTY · blank = no limit)"
              value={cutoff}
              onChange={setCutoff}
              keyboard="default"
            />
            <Field
              label="No new trades after — MCX (IST, HH:MM · blank = no limit)"
              value={cutoffMcx}
              onChange={setCutoffMcx}
              keyboard="default"
            />
            <Text style={[ui.muted, { fontSize: 12 }]}>
              After this time the engine arms no new setups and ENTER is refused; an open trade keeps its stop, target
              and profit lock until it exits.
            </Text>
            {!isFut ? (
              <>
                <Text style={s.label}>Cheap premium filter (options)</Text>
                {CHEAP_FIELDS.map(([k, label]) => (
                  <Field
                    key={k}
                    label={label}
                    value={draft[k] ?? ''}
                    onChange={(v) => setDraft((d) => ({ ...d, [k]: v }))}
                  />
                ))}
                <Text style={[ui.muted, { fontSize: 12 }]}>
                  A setup whose option is cheaper than the minimum, or whose stop-loss is a bigger share of the
                  premium than the maximum, is skipped (signal shows BLOCKED, ENTER is refused). Set either to 0 to
                  switch it off.
                </Text>
              </>
            ) : null}
            {ENGINE_FIELDS.map(([k, label]) => (
              <Field
                key={k}
                label={label}
                value={draft[k] ?? ''}
                onChange={(v) => setDraft((d) => ({ ...d, [k]: v }))}
              />
            ))}
            <View style={s.switchRow}>
              <Text style={s.label}>Engine alerts (Telegram when run on a server)</Text>
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
