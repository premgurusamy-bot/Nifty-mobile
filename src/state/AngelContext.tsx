/**
 * Angel One on this phone (market data for the indexes set to it): the API key, client code and
 * TOTP key are saved once in secure storage; logging in needs only the MPIN. The session is
 * saved for the day, so reopening the app doesn't ask again until tomorrow.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { angelLogin, angelLogout, type AngelSession } from '../../server/angel.ts';
import { isLocalApi, type AngelStatus } from '../api/localApi';
import { istDateString } from '../lib/time';
import { parseTotpKey, totpNow } from '../lib/totp';
import { secret, useSettings } from './SettingsContext';

const K = {
  apiKey: 'nifty.angel-api-key',
  client: 'nifty.angel-client-code',
  totp: 'nifty.angel-totp-key',
  session: 'nifty.angel-session',
};
/** Test builds only (fake Angel One). Unset in real builds → apiconnect.angelone.in. */
const ANGEL_BASE_URL = process.env.EXPO_PUBLIC_ANGEL_BASE_URL || undefined;

interface AngelValue {
  /** Angel One works in the phone's direct-to-Dhan mode. */
  available: boolean;
  /** API key + client code + TOTP key are saved. */
  hasKeys: boolean;
  clientCode: string;
  status: AngelStatus | null;
  saveKeys: (apiKey: string, clientCode: string, totpKey: string) => Promise<void>;
  forgetKeys: () => Promise<void>;
  login: (pin: string) => Promise<void>;
  logout: () => Promise<void>;
  test: () => Promise<string>;
  /** The 6-digit code the app makes now from the saved TOTP key (to compare with your authenticator). */
  currentCode: () => Promise<{ code: string; secondsLeft: number } | null>;
}

const Ctx = createContext<AngelValue | null>(null);

export function AngelProvider({ children }: { children: ReactNode }) {
  const { api, staticIp } = useSettings();
  const local = isLocalApi(api) ? api : null;
  const [hasKeys, setHasKeys] = useState(false);
  const [clientCode, setClientCode] = useState('');
  const [status, setStatus] = useState<AngelStatus | null>(null);

  useEffect(() => {
    void (async () => {
      const [k, c, t] = await Promise.all([secret.get(K.apiKey), secret.get(K.client), secret.get(K.totp)]);
      setHasKeys(!!(k && c && t));
      setClientCode(c ?? '');
    })();
  }, []);

  // A new phone connection: hand it today's saved session (if any), then follow its status.
  useEffect(() => {
    if (!local) return;
    let alive = true;
    let hadSession = false;
    void (async () => {
      const raw = await secret.get(K.session).catch(() => null);
      const s: AngelSession | null = raw ? JSON.parse(raw) : null;
      if (s && istDateString(s.at) === istDateString(Date.now())) {
        hadSession = true;
        if (alive) setStatus(local.angelSetSession(s));
      } else {
        if (s) await secret.del(K.session);
        if (alive) setStatus(local.angelStatus());
      }
    })();
    const t = setInterval(() => {
      const st = local.angelStatus();
      setStatus(st);
      // Angel ended the session (or a new day began): forget it so the app asks to log in again.
      if (hadSession && !st.connected) {
        hadSession = false;
        void secret.del(K.session);
      }
      if (st.connected) hadSession = true;
    }, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [local]);

  const saveKeys = useCallback(async (apiKey: string, code: string, totpKey: string) => {
    const k = apiKey.trim();
    const c = code.trim().toUpperCase();
    if (k.length < 4) throw new Error('Enter the SmartAPI app’s API key');
    if (!c) throw new Error('Enter your Angel One client code');
    const t = parseTotpKey(totpKey); // readable error for a wrong key
    await Promise.all([secret.set(K.apiKey, k), secret.set(K.client, c), secret.set(K.totp, t)]);
    // New keys: a session made with the old ones must not be used any more.
    await secret.del(K.session);
    if (local) setStatus(local.angelSetSession(null));
    setHasKeys(true);
    setClientCode(c);
  }, [local]);

  const logout = useCallback(async () => {
    const raw = await secret.get(K.session).catch(() => null);
    await secret.del(K.session);
    if (local) setStatus(local.angelSetSession(null));
    if (raw) await angelLogout(JSON.parse(raw), ANGEL_BASE_URL);
  }, [local]);

  const forgetKeys = useCallback(async () => {
    await logout();
    await Promise.all([secret.del(K.apiKey), secret.del(K.client), secret.del(K.totp)]);
    setHasKeys(false);
    setClientCode('');
  }, [logout]);

  const login = useCallback(
    async (pin: string) => {
      if (!local) throw new Error('Connect your Dhan account on this phone first (Angel One runs alongside it).');
      const [k, c, t] = await Promise.all([secret.get(K.apiKey), secret.get(K.client), secret.get(K.totp)]);
      if (!k || !c || !t) throw new Error('Save the Angel One API key, client code and TOTP key first.');
      const s = await angelLogin({ apiKey: k, clientCode: c, pin: pin.trim(), totp: totpNow(t), baseUrl: ANGEL_BASE_URL, publicIp: staticIp }).catch((e) => {
        throw new Error(
          `${(e as Error).message}. Check the MPIN, that the TOTP key is the one Angel showed, and that the phone's time is set automatically.`,
        );
      });
      await secret.set(K.session, JSON.stringify(s));
      setStatus(local.angelSetSession(s));
    },
    [local, staticIp],
  );

  const test = useCallback(async () => {
    if (!local) throw new Error('Connect your Dhan account on this phone first.');
    try {
      const r = await local.angelTest('BANKNIFTY');
      setStatus(local.angelStatus());
      return `BANK NIFTY ${r.spot.toFixed(2)} · expiry ${r.expiry} · ${r.strikes} strikes (${r.withOi} with OI, ${r.withIv} with IV) · ${r.candles} candles`;
    } catch (e) {
      // Show which call fails (and whether the IP header matters) instead of one error line.
      const lines = await local.angelDiagnose().catch(() => [] as string[]);
      throw new Error(`${(e as Error).message}${lines.length ? `\n\nStep by step:\n${lines.join('\n')}` : ''}`);
    }
  }, [local]);

  const currentCode = useCallback(async () => {
    const t = await secret.get(K.totp);
    if (!t) return null;
    const now = Date.now();
    return { code: totpNow(t, now), secondsLeft: 30 - (Math.floor(now / 1000) % 30) };
  }, []);

  const value = useMemo<AngelValue>(
    () => ({ available: !!local, hasKeys, clientCode, status: local ? status : null, saveKeys, forgetKeys, login, logout, test, currentCode }),
    [local, hasKeys, clientCode, status, saveKeys, forgetKeys, login, logout, test, currentCode],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAngel() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAngel must be used inside AngelProvider');
  return c;
}
