import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { createApi, type Api } from '../api/client';
import { fetchPublicIp } from '../../server/preflight.ts';
import { createLocalApi, verifyDhanCredentials, type LocalApi } from '../api/localApi';
import type { EngineStore } from '../lib/engine/runner';
import type { StatusResponse } from '../lib/apiTypes';
import { setNiftyLotSize } from '../lib/instruments';

const URL_KEY = 'nifty/server-url';
const API_KEY = 'nifty.server-key';
// Direct-to-Dhan credentials, kept only on this phone (Android Keystore-backed secure storage).
const DHAN_CLIENT_KEY = 'nifty.dhan-client-id';
const DHAN_TOKEN_KEY = 'nifty.dhan-access-token';
const DIRECT_ENGINE_KEY = 'nifty/engine-direct/v1';
/** Test builds only (fake Dhan). Unset in real builds → api.dhan.co. */
const DHAN_BASE_URL = process.env.EXPO_PUBLIC_DHAN_BASE_URL || undefined;
const PUBLIC_IP_URL = process.env.EXPO_PUBLIC_PUBLIC_IP_URL || undefined;
const STATIC_IP_KEY = 'nifty/static-ip';

const directEngineStore: EngineStore = {
  load: async () => {
    const raw = await AsyncStorage.getItem(DIRECT_ENGINE_KEY);
    return raw ? JSON.parse(raw) : null;
  },
  save: async (state, config) => {
    await AsyncStorage.setItem(DIRECT_ENGINE_KEY, JSON.stringify({ state, config }));
  },
};

// SecureStore (Keychain/Keystore) on device; web falls back to AsyncStorage.
const secret = {
  get: (k: string) => (Platform.OS === 'web' ? AsyncStorage.getItem(k) : SecureStore.getItemAsync(k)),
  set: (k: string, v: string) => (Platform.OS === 'web' ? AsyncStorage.setItem(k, v) : SecureStore.setItemAsync(k, v)),
  del: (k: string) => (Platform.OS === 'web' ? AsyncStorage.removeItem(k) : SecureStore.deleteItemAsync(k)),
};

export type DataMode = 'DEMO' | 'DHAN';
/** SERVER = your bridge server; DIRECT = this phone talks to Dhan itself. */
export type Connection = 'SERVER' | 'DIRECT' | 'DEMO';

interface SettingsValue {
  loaded: boolean;
  serverUrl: string;
  mode: DataMode;
  api: Api | null;
  server: StatusResponse | null;
  /** Saves and verifies the connection; throws with a readable message on failure. */
  connect: (url: string, key: string) => Promise<StatusResponse>;
  disconnect: () => Promise<void>;
  connection: Connection;
  /** Saved direct-mode client id (shown masked), or '' when none is saved. */
  directClientId: string;
  /** Verifies with Dhan, then saves the client id + token on this phone. */
  saveDirect: (clientId: string, accessToken: string) => Promise<number>;
  clearDirect: () => Promise<void>;
  /** Static IP whitelisted at Dhan for orders (saved on this phone). */
  staticIp: string;
  saveStaticIp: (ip: string) => Promise<void>;
  /** Re-read connection status (e.g. after switching PAPER/LIVE). */
  refreshStatus: () => Promise<void>;
}

const Ctx = createContext<SettingsValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [serverUrl, setServerUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [server, setServer] = useState<StatusResponse | null>(null);
  const [direct, setDirect] = useState<{ clientId: string; token: string } | null>(null);
  const [localApi, setLocalApi] = useState<LocalApi | null>(null);
  const [staticIp, setStaticIp] = useState('');
  const staticIpRef = useRef('');

  useEffect(() => {
    (async () => {
      try {
        const [u, k, cid, tok] = await Promise.all([
          AsyncStorage.getItem(URL_KEY),
          secret.get(API_KEY),
          secret.get(DHAN_CLIENT_KEY),
          secret.get(DHAN_TOKEN_KEY),
        ]);
        const ip = (await AsyncStorage.getItem(STATIC_IP_KEY)) ?? '';
        staticIpRef.current = ip;
        setStaticIp(ip);
        if (u && k) {
          setServerUrl(u);
          setApiKey(k);
        }
        if (cid && tok) setDirect({ clientId: cid, token: tok });
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const serverApi = useMemo(() => (serverUrl && apiKey ? createApi(serverUrl, apiKey) : null), [serverUrl, apiKey]);

  // Direct mode runs the Dhan client + engine on the phone — only when no server is configured.
  const useDirect = !serverApi && !!direct;
  useEffect(() => {
    if (!useDirect || !direct) return;
    let alive = true;
    let made: LocalApi | null = null;
    createLocalApi({
      clientId: direct.clientId,
      accessToken: direct.token,
      baseUrl: DHAN_BASE_URL,
      staticIp: () => staticIpRef.current,
      publicIp: () => fetchPublicIp(PUBLIC_IP_URL),
      store: directEngineStore,
      // A renewed token replaces the saved one (without restarting the connection).
      persistToken: (t) => secret.set(DHAN_TOKEN_KEY, t),
    }).then((a) => {
      made = a;
      if (alive) setLocalApi(a);
      else a.dispose();
    });
    return () => {
      alive = false;
      made?.dispose();
      setLocalApi(null);
    };
  }, [useDirect, direct]);

  const api: Api | null = serverApi ?? (useDirect ? localApi : null);
  const connection: Connection = serverApi ? 'SERVER' : useDirect && localApi ? 'DIRECT' : 'DEMO';

  useEffect(() => {
    if (!api) return; // disconnect() clears `server` itself
    api
      .status()
      .then((s) => {
        setServer(s);
        setNiftyLotSize(s.lotSize);
      })
      .catch(() => setServer(null));
  }, [api]);

  const connect = useCallback(async (url: string, key: string) => {
    const clean = url.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(clean)) throw new Error('Server URL must start with http:// or https://');
    const status = await createApi(clean, key.trim()).status();
    await AsyncStorage.setItem(URL_KEY, clean);
    await secret.set(API_KEY, key.trim());
    setServerUrl(clean);
    setApiKey(key.trim());
    setServer(status);
    setNiftyLotSize(status.lotSize);
    return status;
  }, []);

  const disconnect = useCallback(async () => {
    await AsyncStorage.removeItem(URL_KEY);
    await secret.del(API_KEY);
    setServerUrl('');
    setApiKey('');
    setServer(null);
  }, []);

  const saveDirect = useCallback(async (clientId: string, accessToken: string) => {
    const cid = clientId.trim();
    const tok = accessToken.trim();
    if (!/^\d{5,}$/.test(cid)) throw new Error('Dhan client id is the number shown on your Dhan profile.');
    if (tok.length < 20) throw new Error('That does not look like a Dhan access token.');
    const nifty = await verifyDhanCredentials(cid, tok, DHAN_BASE_URL);
    await secret.set(DHAN_CLIENT_KEY, cid);
    await secret.set(DHAN_TOKEN_KEY, tok);
    setDirect({ clientId: cid, token: tok });
    return nifty;
  }, []);

  const clearDirect = useCallback(async () => {
    await secret.del(DHAN_CLIENT_KEY);
    await secret.del(DHAN_TOKEN_KEY);
    setDirect(null);
    setServer(null);
  }, []);

  const saveStaticIp = useCallback(async (ip: string) => {
    const clean = ip.trim();
    await AsyncStorage.setItem(STATIC_IP_KEY, clean);
    staticIpRef.current = clean;
    setStaticIp(clean);
  }, []);

  const refreshStatus = useCallback(async () => {
    if (!api) return;
    const s = await api.status();
    setServer(s);
  }, [api]);

  const directClientId = direct?.clientId ?? '';
  const value = useMemo<SettingsValue>(
    () => ({
      loaded,
      serverUrl,
      mode: api ? 'DHAN' : 'DEMO',
      api,
      server,
      connect,
      disconnect,
      connection,
      directClientId,
      saveDirect,
      clearDirect,
      staticIp,
      saveStaticIp,
      refreshStatus,
    }),
    [
      loaded,
      serverUrl,
      api,
      server,
      connect,
      disconnect,
      connection,
      directClientId,
      saveDirect,
      clearDirect,
      staticIp,
      saveStaticIp,
      refreshStatus,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSettings() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSettings must be used inside SettingsProvider');
  return c;
}
