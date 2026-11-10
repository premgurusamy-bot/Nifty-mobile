/**
 * License lock for the licensed copy (Nifty Trader v1): the app opens only with a valid key for this
 * phone. Shows the phone's App ID (send it to the owner), takes the key the owner sends back, and
 * locks again when the key ends. The phone's date being set back is caught (last time seen, and the
 * internet time when there is a connection).
 */
import * as SecureStore from 'expo-secure-store';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { checkLicense, newAppId, type LicenseCheck } from '../lib/license';
import { LICENSE_PUBLIC_KEY } from '../lib/licensePublicKey';
import { colors } from '../theme';

const K_ID = 'license.appId';
const K_KEY = 'license.key';
const K_SEEN = 'license.lastSeen';

async function get(k: string) {
  try {
    return await SecureStore.getItemAsync(k);
  } catch {
    return null;
  }
}
async function set(k: string, v: string) {
  try {
    await SecureStore.setItemAsync(k, v);
  } catch {
    /* kept in memory for this run */
  }
}

/** Internet time (the Date header of a tiny request), null offline. */
async function netTime(): Promise<number | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch('https://www.google.com/generate_204', { method: 'HEAD', signal: ctrl.signal });
    clearTimeout(t);
    const d = Date.parse(r.headers.get('date') ?? '');
    return Number.isFinite(d) ? d : null;
  } catch {
    return null;
  }
}

type View_ = { state: 'loading' } | { state: 'locked'; appId: string; why: string } | { state: 'open'; appId: string; check: Extract<LicenseCheck, { ok: true }> };

export function LicenseGate({ children }: { children: ReactNode }) {
  const [v, setV] = useState<View_>({ state: 'loading' });
  const net = useRef<{ at: number; offset: number } | null>(null);

  const evaluate = useCallback(async (keyOverride?: string) => {
    let appId = await get(K_ID);
    if (!appId) {
      appId = newAppId();
      await set(K_ID, appId);
    }
    const key = keyOverride ?? (await get(K_KEY)) ?? '';
    // Internet time every 30 minutes when online.
    if (!net.current || Date.now() - net.current.at > 30 * 60_000) {
      const t = await netTime();
      if (t != null) net.current = { at: Date.now(), offset: t - Date.now() };
    }
    const local = Date.now();
    const now = net.current ? Math.max(local, local + net.current.offset) : local;
    const seen = Number((await get(K_SEEN)) ?? 0);
    if (seen && local < seen - 6 * 3600_000 && !net.current) {
      setV({ state: 'locked', appId, why: "The phone's date was set back. Set the correct date and time, then try again." });
      return false;
    }
    if (!key) {
      setV({ state: 'locked', appId, why: 'This app needs a license key.' });
      return false;
    }
    const c = checkLicense(key, appId, LICENSE_PUBLIC_KEY, now);
    if (!c.ok) {
      setV({ state: 'locked', appId, why: c.reason });
      return false;
    }
    if (keyOverride) await set(K_KEY, keyOverride.replace(/\s/g, ''));
    await set(K_SEEN, String(Math.max(seen, now)));
    setV({ state: 'open', appId, check: c });
    return true;
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void evaluate(), 0);
    const t = setInterval(() => void evaluate(), 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [evaluate]);

  if (v.state === 'loading') return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  if (v.state === 'locked') return <LockScreen appId={v.appId} why={v.why} onKey={(k) => evaluate(k)} />;
  const left = v.check.daysLeft;
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {children}
      {left <= 5 ? (
        <View style={s.banner} pointerEvents="none">
          <Text style={s.bannerText}>
            License ends {left <= 1 ? 'today' : `in ${left} days`} ({v.check.info.expires}). Ask for a new key — App ID {v.appId}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function LockScreen({ appId, why, onKey }: { appId: string; why: string; onKey: (k: string) => Promise<boolean> }) {
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setMsg('');
    const ok = await onKey(key);
    setBusy(false);
    if (!ok) setMsg('Key not accepted — see the reason above.');
  };
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: 20, paddingTop: 60, gap: 14 }}>
      <Text style={s.title}>Nifty Trader v1</Text>
      <Text style={[s.text, { color: colors.warn }]}>{why}</Text>
      <View style={s.card}>
        <Text style={s.muted}>Your App ID</Text>
        <Text selectable style={s.appId}>
          {appId}
        </Text>
        <Pressable
          style={s.btn}
          accessibilityRole="button"
          onPress={() => void Share.share({ message: `Nifty Trader v1 — App ID: ${appId}` }).catch(() => {})}
        >
          <Text style={s.btnText}>Send App ID</Text>
        </Pressable>
        <Text style={s.muted}>Send this to the owner. They send back a key for this phone (it works for 30 days).</Text>
      </View>
      <View style={s.card}>
        <Text style={s.muted}>License key</Text>
        <TextInput
          value={key}
          onChangeText={setKey}
          placeholder="NT1-…  (long-press to paste)"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          style={s.input}
        />
        <Pressable style={[s.btn, { opacity: busy || !key.trim() ? 0.5 : 1 }]} disabled={busy || !key.trim()} accessibilityRole="button" onPress={() => void submit()}>
          <Text style={s.btnText}>{busy ? 'Checking…' : 'Unlock'}</Text>
        </Pressable>
        {msg ? <Text style={[s.text, { color: colors.down }]}>{msg}</Text> : null}
      </View>
      <Text style={s.muted}>
        The key works on this phone only. Uninstalling the app or clearing its data makes a new App ID (then a new key is needed). Orders already at your broker stay there while the app is locked.
      </Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  title: { color: colors.text, fontSize: 24, fontWeight: '800' },
  text: { color: colors.text, fontSize: 15 },
  muted: { color: colors.muted, fontSize: 13 },
  card: { backgroundColor: colors.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 14, gap: 10 },
  appId: { color: colors.text, fontSize: 22, fontWeight: '800', letterSpacing: 1, fontFamily: 'monospace' },
  input: { color: colors.text, backgroundColor: colors.cardAlt, borderRadius: 8, padding: 10, minHeight: 90, fontFamily: 'monospace', textAlignVertical: 'top' },
  btn: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  banner: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: '#7F1D1D', padding: 8 },
  bannerText: { color: '#fff', fontSize: 12, fontWeight: '600', textAlign: 'center' },
});
