import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { createApi, type Api } from '../api/client';
import type { StatusResponse } from '../lib/apiTypes';
import { setNiftyLotSize } from '../lib/instruments';

const URL_KEY = 'nifty/server-url';
const API_KEY = 'nifty.server-key';

// SecureStore (Keychain/Keystore) on device; web falls back to AsyncStorage.
const secret = {
  get: (k: string) => (Platform.OS === 'web' ? AsyncStorage.getItem(k) : SecureStore.getItemAsync(k)),
  set: (k: string, v: string) => (Platform.OS === 'web' ? AsyncStorage.setItem(k, v) : SecureStore.setItemAsync(k, v)),
  del: (k: string) => (Platform.OS === 'web' ? AsyncStorage.removeItem(k) : SecureStore.deleteItemAsync(k)),
};

export type DataMode = 'DEMO' | 'DHAN';

interface SettingsValue {
  loaded: boolean;
  serverUrl: string;
  mode: DataMode;
  api: Api | null;
  server: StatusResponse | null;
  /** Saves and verifies the connection; throws with a readable message on failure. */
  connect: (url: string, key: string) => Promise<StatusResponse>;
  disconnect: () => Promise<void>;
}

const Ctx = createContext<SettingsValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [serverUrl, setServerUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [server, setServer] = useState<StatusResponse | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [u, k] = await Promise.all([AsyncStorage.getItem(URL_KEY), secret.get(API_KEY)]);
        if (u && k) {
          setServerUrl(u);
          setApiKey(k);
        }
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const api = useMemo(() => (serverUrl && apiKey ? createApi(serverUrl, apiKey) : null), [serverUrl, apiKey]);

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

  const value = useMemo<SettingsValue>(
    () => ({ loaded, serverUrl, mode: api ? 'DHAN' : 'DEMO', api, server, connect, disconnect }),
    [loaded, serverUrl, api, server, connect, disconnect],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSettings() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSettings must be used inside SettingsProvider');
  return c;
}
