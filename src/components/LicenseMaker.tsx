/**
 * Owner only: make license keys for the licensed copy (Nifty Trader v1). The secret key is kept in
 * this phone's secure storage; a key is made from the other phone's App ID and the number of days.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useState } from 'react';
import { Platform, Share, Text, TextInput, View } from 'react-native';
import { makeLicense, publicKeyOf } from '../lib/license';
import { LICENSE_PUBLIC_KEY } from '../lib/licensePublicKey';
import { colors } from '../theme';
import { Button, Card, styles as ui } from './ui';

const K_SECRET = 'owner.licenseSecret';
const K_MADE = 'owner.licensesMade';
const store = {
  get: (k: string) => (Platform.OS === 'web' ? AsyncStorage.getItem(k) : SecureStore.getItemAsync(k)),
  set: (k: string, v: string) => (Platform.OS === 'web' ? AsyncStorage.setItem(k, v) : SecureStore.setItemAsync(k, v)),
  del: (k: string) => (Platform.OS === 'web' ? AsyncStorage.removeItem(k) : SecureStore.deleteItemAsync(k)),
};

interface Made {
  appId: string;
  note: string;
  expires: string;
  at: number;
  key: string;
}

const input = {
  color: colors.text,
  backgroundColor: colors.cardAlt,
  borderRadius: 8,
  padding: 10,
  borderWidth: 1,
  borderColor: colors.border,
} as const;

export function LicenseMakerCard() {
  const [secret, setSecret] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [appId, setAppId] = useState('');
  const [note, setNote] = useState('');
  const [days, setDays] = useState('30');
  const [made, setMade] = useState<Made[]>([]);
  const [msg, setMsg] = useState('');
  const [last, setLast] = useState<Made | null>(null);

  useEffect(() => {
    void store.get(K_SECRET).then((s) => setSecret(s ?? ''));
    void AsyncStorage.getItem(K_MADE).then((j) => setMade(j ? (JSON.parse(j) as Made[]) : []));
  }, []);

  const saveSecret = async () => {
    setMsg('');
    try {
      const s = draft.trim();
      if (publicKeyOf(s) !== LICENSE_PUBLIC_KEY) throw new Error('This secret key does not match the licensed app (wrong key).');
      await store.set(K_SECRET, s);
      setSecret(s);
      setDraft('');
      setMsg('Secret key saved on this phone.');
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const make = async () => {
    setMsg('');
    try {
      const { key, info } = makeLicense(secret!, appId, Number(days));
      const m: Made = { appId: info.appId, note: note.trim(), expires: info.expires, at: Date.now(), key };
      const list = [m, ...made].slice(0, 50);
      setMade(list);
      setLast(m);
      await AsyncStorage.setItem(K_MADE, JSON.stringify(list));
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const share = (m: Made) =>
    void Share.share({ message: `Nifty Trader v1 license key (works until ${m.expires}):\n${m.key}` }).catch(() => {});

  if (secret === null) return null;
  return (
    <Card style={{ gap: 10 }}>
      <Text style={[ui.sectionTitle, { marginTop: 0 }]}>License keys (Nifty Trader v1)</Text>
      {!secret ? (
        <>
          <Text style={ui.muted}>Paste your secret key (starts with NTSK-) once. It stays in this phone&apos;s secure storage.</Text>
          <TextInput value={draft} onChangeText={setDraft} placeholder="NTSK-…" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} secureTextEntry style={input} />
          <Button label="Save secret key" onPress={() => void saveSecret()} disabled={!draft.trim()} />
        </>
      ) : (
        <>
          <Text style={ui.muted}>Ask the other person for the App ID shown on their locked app, then make a key and send it.</Text>
          <TextInput value={appId} onChangeText={setAppId} placeholder="App ID, e.g. AB12-CD34-EF56-7890" placeholderTextColor={colors.muted} autoCapitalize="characters" autoCorrect={false} style={input} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput value={note} onChangeText={setNote} placeholder="Name (for you)" placeholderTextColor={colors.muted} style={[input, { flex: 2 }]} />
            <TextInput value={days} onChangeText={setDays} keyboardType="number-pad" placeholder="Days" placeholderTextColor={colors.muted} style={[input, { flex: 1 }]} />
          </View>
          <Button label={`Make key (${Number(days) || 0} days)`} onPress={() => void make()} disabled={!appId.trim()} />
          {last ? (
            <View style={{ gap: 6 }}>
              <Text style={{ color: colors.up, fontWeight: '700' }}>
                Key for {last.appId}
                {last.note ? ` (${last.note})` : ''} — works until {last.expires}
              </Text>
              <Text selectable style={[ui.muted, { fontFamily: 'monospace' }]}>
                {last.key}
              </Text>
              <Button label="Send key" onPress={() => share(last)} color={colors.up} />
            </View>
          ) : null}
          {made.length ? (
            <View style={{ gap: 4 }}>
              <Text style={ui.statLabel}>Keys made</Text>
              {made.slice(0, 10).map((m) => (
                <Text key={m.at} style={ui.muted} onPress={() => share(m)}>
                  {m.note || m.appId} · until {m.expires} · tap to send again
                </Text>
              ))}
            </View>
          ) : null}
          <Text style={ui.muted} onPress={() => void store.del(K_SECRET).then(() => setSecret(''))}>
            Remove the secret key from this phone (keep your backup copy!)
          </Text>
        </>
      )}
      {msg ? <Text style={{ color: msg.startsWith('Secret key saved') ? colors.up : colors.down }}>{msg}</Text> : null}
    </Card>
  );
}
