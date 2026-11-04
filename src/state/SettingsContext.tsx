import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { createApi, type Api } from '../api/client';
import { fetchPublicIp } from '../../server/preflight.ts';
import { dhanPinLogin } from '../../server/dhan.ts';
import { loginSafety, logoutSafety, type SessionSnapshot } from '../lib/session';
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
/** The Dhan client ID last logged in on this phone (not secret; used to spot an account change). */
const LAST_CLIENT_KEY = 'nifty/dhan-last-client';
const DHAN_AUTH_URL = process.env.EXPO_PUBLIC_DHAN_AUTH_URL || undefined;

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
  /** Log in with Dhan client ID + PIN + TOTP: gets a 24-hour token and uses it. */
  login: (clientId: string, pin: string, totp: string) => Promise<number>;
  /** Log out: drop the token, switch to PAPER, automatic LIVE entries off (refused with an open LIVE position). */
  logout: () => Promise<void>;
  /** Client ID last used on this phone (to prefill the login form). */
  lastClientId: string;
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
  const [lastClientId, setLastClientId] = useState('');
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
        setLastClientId((await AsyncStorage.getItem(LAST_CLIENT_KEY)) ?? cid ?? '');
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

  // ---- Login safety: read / patch the engine's saved settings (running engine if any, else storage).
  const readSession = useCallback(async (): Promise<SessionSnapshot | null> => {
    if (localApi) {
      const s = await localApi.engine();
      return { config: s.config, position: s.state.position };
    }
    const raw = await AsyncStorage.getItem(DIRECT_ENGINE_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    return j?.config ? { config: j.config, position: j.state?.position ?? null } : null;
  }, [localApi]);

  const applySession = useCallback(
    async (r: { patch: Record<string, unknown>; toPaper: boolean }) => {
      if (localApi) {
        await localApi.engineConfig(r.patch);
        if (r.toPaper) await localApi.setTradeMode('PAPER');
        return;
      }
      const raw = await AsyncStorage.getItem(DIRECT_ENGINE_KEY);
      if (!raw) return;
      const j = JSON.parse(raw);
      j.config = { ...j.config, ...r.patch, ...(r.toPaper ? { tradeMode: 'PAPER' } : {}) };
      await AsyncStorage.setItem(DIRECT_ENGINE_KEY, JSON.stringify(j));
    },
    [localApi],
  );

  /** Verify a client ID + token with Dhan, apply the login safety rules, then use them. */
  const adoptCredentials = useCallback(
    async (cid: string, tok: string) => {
      const nifty = await verifyDhanCredentials(cid, tok, DHAN_BASE_URL);
      const last = (await AsyncStorage.getItem(LAST_CLIENT_KEY)) ?? direct?.clientId ?? null;
      await applySession(loginSafety(await readSession(), last, cid));
      await secret.set(DHAN_CLIENT_KEY, cid);
      await secret.set(DHAN_TOKEN_KEY, tok);
      await AsyncStorage.setItem(LAST_CLIENT_KEY, cid);
      setLastClientId(cid);
      setDirect({ clientId: cid, token: tok });
      return nifty;
    },
    [applySession, readSession, direct],
  );

  const saveDirect = useCallback(
    async (clientId: string, accessToken: string) => {
      const cid = clientId.trim();
      const tok = accessToken.trim();
      if (!/^\d{5,}$/.test(cid)) throw new Error('Dhan client id is the number shown on your Dhan profile.');
      if (tok.length < 20) throw new Error('That does not look like a Dhan access token.');
      return adoptCredentials(cid, tok);
    },
    [adoptCredentials],
  );

  const login = useCallback(
    async (clientId: string, pin: string, totp: string) => {
      const cid = clientId.trim();
      const { accessToken } = await dhanPinLogin({ clientId: cid, pin, totp, authUrl: DHAN_AUTH_URL });
      return adoptCredentials(cid, accessToken);
    },
    [adoptCredentials],
  );

  const logout = useCallback(async () => {
    await applySession(logoutSafety(await readSession()));
    await secret.del(DHAN_TOKEN_KEY);
    setDirect(null);
    setServer(null);
  }, [applySession, readSession]);

  /** Log out and forget the client ID too. */
  const clearDirect = useCallback(async () => {
    await logout();
    await secret.del(DHAN_CLIENT_KEY);
    await AsyncStorage.removeItem(LAST_CLIENT_KEY);
    setLastClientId('');
  }, [logout]);

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
      login,
      logout,
      lastClientId,
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
      login,
      logout,
      lastClientId,
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
