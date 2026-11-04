import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform, Pressable, StyleSheet, Text, Vibration, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  DEFAULT_ALERT_PREFS,
  isOrderErrorStatus,
  loadPrefs,
  newAlerts,
  statusLine,
  VOLUME,
  type AlertCategory,
  type AlertItem,
  type AlertPrefs,
} from '../lib/alerts';
import { backgroundSupported, heartbeat, isBackgroundRunning, startBackground, stopBackground } from '../lib/background';
import { ensureNotificationPermission, notifyNow } from '../lib/notify';
import { colors } from '../theme';
import { useEngine } from './EngineContext';

/**
 * Phone alerts for engine events: an on-screen message, a sound (built-in tone or
 * a file you pick, at Low / Medium / High volume) and vibration. Works while the
 * app is open — that's also when the engine refreshes.
 */
interface AlertsValue {
  prefs: AlertPrefs;
  update: (patch: Partial<AlertPrefs>) => Promise<void>;
  setCategory: (c: AlertCategory, on: boolean) => Promise<void>;
  /** Pick an audio file from the phone as the alert sound. Returns its name, or null if cancelled. */
  pickCustom: () => Promise<string | null>;
  /** Play the current sound + show a sample message. */
  test: () => void;
  /** Background running (Android). */
  bg: { supported: boolean; running: boolean; error: string | null; notifications: boolean | null };
  /** Turn background running on (also turns auto-refresh on) or off. */
  setBackground: (on: boolean) => Promise<void>;
}

const Ctx = createContext<AlertsValue | null>(null);
const KEY = 'nifty/alerts/v1';

const BUILT_IN = {
  chime: require('../../assets/sounds/chime.wav'),
  beep: require('../../assets/sounds/beep.wav'),
  bell: require('../../assets/sounds/bell.wav'),
  alarm: require('../../assets/sounds/alarm.wav'),
} as const;

const sourceOf = (p: AlertPrefs) => (p.tone === 'custom' && p.customUri ? { uri: p.customUri } : BUILT_IN[p.tone === 'custom' ? 'chime' : p.tone]);

const ACCENT: Record<AlertCategory, string> = {
  signal: colors.accent,
  entry: colors.up,
  target: colors.up,
  stop: colors.down,
  exit: colors.warn,
  error: colors.down,
};

export function AlertsProvider({ children }: { children: ReactNode }) {
  const { snap, updateConfig } = useEngine();
  const snapRef = useRef(snap);
  const [bg, setBg] = useState<AlertsValue['bg']>({
    supported: backgroundSupported(),
    running: false,
    error: null,
    notifications: null,
  });
  const [prefs, setPrefs] = useState<AlertPrefs>(DEFAULT_ALERT_PREFS);
  // Latest prefs for callbacks; written together with the state (never during render).
  const prefsRef = useRef(prefs);
  const [shown, setShown] = useState<AlertItem[]>([]);
  const player = useRef<AudioPlayer | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const lastStatus = useRef('');

  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((raw) => {
        const p = loadPrefs(raw ? JSON.parse(raw) : null);
        prefsRef.current = p;
        setPrefs(p);
      })
      .catch(() => {});
    // Alerts should be heard with the silent switch on and while the app is in the background.
    setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'duckOthers' }).catch(
      () => {},
    );
  }, []);

  // One player per chosen sound; swapped when the sound changes.
  const sourceKey = prefs.tone === 'custom' ? prefs.customUri : prefs.tone;
  useEffect(() => {
    let p: AudioPlayer | null = null;
    try {
      p = createAudioPlayer(sourceOf(prefsRef.current));
      player.current = p;
    } catch {
      player.current = null;
    }
    return () => {
      if (player.current === p) player.current = null;
      p?.remove();
    };
  }, [sourceKey]);

  const persist = useCallback(async (next: AlertPrefs) => {
    prefsRef.current = next;
    setPrefs(next);
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
  }, []);

  const ring = useCallback((category: AlertCategory) => {
    const p = prefsRef.current;
    if (p.sound && player.current) {
      try {
        player.current.volume = VOLUME[p.volume];
        void player.current.seekTo(0).catch(() => {});
        player.current.play();
      } catch {
        /* a broken custom file must not break trading */
      }
    }
    // In the background the notification channel vibrates instead.
    if (p.vibrate && Platform.OS !== 'web' && AppState.currentState === 'active') {
      Vibration.vibrate(category === 'stop' || category === 'error' ? [0, 500, 200, 500, 200, 500] : [0, 350, 150, 350]);
    }
  }, []);

  const raise = useCallback(
    (items: AlertItem[]) => {
      if (!items.length) return;
      ring(items[items.length - 1].category);
      const p = prefsRef.current;
      // Away from the app: a system notification that pops up over other apps / the lock screen.
      if (p.popup && AppState.currentState !== 'active') {
        for (const a of items) notifyNow({ title: a.title, body: a.message, category: a.category }).catch(() => {});
      }
      if (p.popup) setShown((s) => [...[...items].reverse(), ...s].slice(0, 3));
    },
    [ring],
  );

  // Watch the engine's event log (and live-order error statuses).
  useEffect(() => {
    if (!snap) return;
    const prime = seen.current === null;
    if (prime) seen.current = new Set();
    raise(newAlerts(snap.state.events, seen.current!, prefsRef.current, prime));
    const st = snap.status ?? '';
    if (st !== lastStatus.current) {
      lastStatus.current = st;
      const p = prefsRef.current;
      if (!prime && p.enabled && p.categories.error && isOrderErrorStatus(st)) {
        raise([{ key: `status|${Date.now()}`, category: 'error', title: 'Order problem', message: st, at: Date.now() }]);
      }
    }
  }, [snap, raise]);

  // Background running: start/stop the service with the setting; heartbeat while the UI is alive.
  useEffect(() => {
    snapRef.current = snap;
  }, [snap]);
  useEffect(() => {
    if (!bg.supported) return;
    let cancelled = false;
    const sync = async () => {
      try {
        if (prefs.background) {
          const desc = snapRef.current ? statusLine(snapRef.current) : 'Starting…';
          await startBackground(desc);
        } else await stopBackground();
        if (!cancelled) setBg((b) => ({ ...b, running: isBackgroundRunning(), error: null }));
      } catch (e) {
        if (!cancelled) setBg((b) => ({ ...b, running: isBackgroundRunning(), error: (e as Error).message }));
      }
    };
    void sync();
    return () => {
      cancelled = true;
    };
  }, [prefs.background, bg.supported]);
  useEffect(() => {
    const beat = () => heartbeat(snapRef.current ? statusLine(snapRef.current) : undefined);
    beat();
    const t = setInterval(() => {
      beat();
      setBg((b) => (b.running === isBackgroundRunning() ? b : { ...b, running: isBackgroundRunning() }));
    }, 15_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (snap) heartbeat(statusLine(snap));
  }, [snap]);

  // Pop-ups clear themselves (stop-loss / errors stay longer).
  useEffect(() => {
    if (!shown.length) return;
    const last = shown[shown.length - 1];
    const ms = last.category === 'stop' || last.category === 'error' ? 15000 : 8000;
    const t = setTimeout(() => setShown((s) => s.filter((x) => x.key !== last.key)), ms);
    return () => clearTimeout(t);
  }, [shown]);

  const value = useMemo<AlertsValue>(
    () => ({
      prefs,
      update: (patch) => persist({ ...prefsRef.current, ...patch }),
      setCategory: (c, on) =>
        persist({ ...prefsRef.current, categories: { ...prefsRef.current.categories, [c]: on } }),
      pickCustom: async () => {
        const r = await DocumentPicker.getDocumentAsync({ type: 'audio/*', copyToCacheDirectory: true, multiple: false });
        if (r.canceled || !r.assets?.length) return null;
        const a = r.assets[0];
        let uri = a.uri;
        if (Platform.OS !== 'web') {
          // Keep our own copy: the picker's cache copy can be cleared by the system.
          const ext = (a.name.match(/\.[a-z0-9]{1,5}$/i)?.[0] ?? '.mp3').toLowerCase();
          const dest = new File(Paths.document, `alert-sound-${Date.now()}${ext}`);
          await new File(a.uri).copy(dest);
          const old = prefsRef.current.customUri;
          if (old && old.startsWith(Paths.document.uri)) {
            try {
              new File(old).delete();
            } catch {
              /* already gone */
            }
          }
          uri = dest.uri;
        }
        await persist({ ...prefsRef.current, tone: 'custom', customUri: uri, customName: a.name });
        return a.name;
      },
      bg,
      setBackground: async (on) => {
        if (on) {
          const granted = await ensureNotificationPermission().catch(() => false);
          setBg((b) => ({ ...b, notifications: granted }));
          if (snapRef.current && !snapRef.current.config.autoRefresh) await updateConfig({ autoRefresh: true });
        }
        await persist({ ...prefsRef.current, background: on });
      },
      test: () =>
        raise([
          {
            key: `test|${Date.now()}`,
            category: 'signal',
            title: 'Test alert',
            message: `Sound: ${prefsRef.current.tone === 'custom' ? prefsRef.current.customName : prefsRef.current.tone} · volume ${prefsRef.current.volume.toLowerCase()}`,
            at: Date.now(),
          },
        ]),
    }),
    [prefs, persist, raise, bg, updateConfig],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <AlertBanners items={shown} onDismiss={(k) => setShown((s) => s.filter((x) => x.key !== k))} />
    </Ctx.Provider>
  );
}

function AlertBanners({ items, onDismiss }: { items: AlertItem[]; onDismiss: (key: string) => void }) {
  const insets = useSafeAreaInsets();
  if (!items.length) return null;
  return (
    <View pointerEvents="box-none" style={[st.wrap, { top: insets.top + 8 }]}>
      {items.map((a) => (
        <Pressable
          key={a.key}
          onPress={() => onDismiss(a.key)}
          accessibilityRole="alert"
          style={[st.banner, { borderLeftColor: ACCENT[a.category] }]}
        >
          <Text style={[st.title, { color: ACCENT[a.category] }]}>{a.title}</Text>
          <Text style={st.msg}>{a.message}</Text>
          <Text style={st.hint}>Tap to dismiss</Text>
        </Pressable>
      ))}
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { position: 'absolute', left: 12, right: 12, gap: 8, zIndex: 1000, elevation: 1000 },
  banner: {
    backgroundColor: colors.cardAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderLeftWidth: 5,
    borderRadius: 12,
    padding: 12,
    gap: 4,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  title: { fontWeight: '800', fontSize: 15 },
  msg: { color: colors.text, fontSize: 14 },
  hint: { color: colors.muted, fontSize: 11 },
});

export function useAlerts() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAlerts must be used inside AlertsProvider');
  return v;
}
