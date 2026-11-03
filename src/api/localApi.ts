/**
 * Direct-to-Dhan mode: the phone itself talks to api.dhan.co with the client id
 * and access token saved on this device. It reuses the server's Dhan client,
 * mapping, service and engine code, behind the same interface as the server
 * API (`createApi`), so every screen works unchanged.
 *
 * Differences from running the server:
 *  - Orders are refused: Dhan only accepts order APIs from a whitelisted static
 *    IP, which a phone doesn't have. Portfolio/Orders paper-trade on live prices.
 *  - The engine runs only while the app is open (Android pauses background JS).
 *  - No scrip master download; option security ids come from the option chain.
 */
import { DhanClient } from '../../server/dhan.ts';
import { DhanEngineSource } from '../../server/engineSource.ts';
import { DhanService } from '../../server/service.ts';
import { TokenKeeper } from '../../server/tokenKeeper.ts';
import type { StatusResponse } from '../lib/apiTypes';
import { EngineRunner, type EngineStore } from '../lib/engine/runner.ts';
import type { EngineConfig } from '../lib/engine/types';
import type { Api } from './client';

export interface LocalApiOptions {
  clientId: string;
  accessToken: string;
  /** Where the engine's journal / IV history / position are kept on the device. */
  store: EngineStore;
  /** Called with a renewed token so it can be saved on the device. */
  persistToken?: (token: string) => void | Promise<void>;
  /** Tests only: point at a fake Dhan. */
  baseUrl?: string;
}

export const DIRECT_ORDERS_MESSAGE =
  'Orders need the server: Dhan only accepts order APIs from your whitelisted static IP, not from a phone.';

export type LocalApi = Api & { dispose: () => void };

export async function createLocalApi(o: LocalApiOptions): Promise<LocalApi> {
  const dhan = new DhanClient({ clientId: o.clientId, accessToken: o.accessToken, baseUrl: o.baseUrl });
  const service = new DhanService(dhan, { liveOrders: false, maxOrderValue: 0 });
  const engine = new EngineRunner(new DhanEngineSource(dhan), o.store);
  await engine.init();
  engine.syncTimer();
  const token = new TokenKeeper(dhan, { autoRenew: true, persist: o.persistToken });
  token.start();

  const status = (): StatusResponse => {
    const st = service.status();
    const t = token.status;
    st.token = { ok: t.ok, validUntil: t.validUntil, lastRenewal: t.lastRenewal, message: t.message };
    if (!t.ok && t.lastCheck) st.ok = false;
    return st;
  };

  return {
    status: async () => status(),
    quotes: async (ids) => {
      let quotes = service.getQuotes(ids);
      if (quotes.length < ids.length) {
        await service.primeQuotes(ids);
        quotes = service.getQuotes(ids);
      }
      return { quotes };
    },
    intraday: async (id) => ({ points: await service.intraday(id) }),
    expiries: async () => ({ expiries: await service.expiries() }),
    optionChain: (expiry) => service.optionChain(expiry),
    portfolio: () => service.portfolio(),
    orders: () => service.orders(),
    placeOrder: async () => {
      throw new Error(DIRECT_ORDERS_MESSAGE);
    },
    cancelOrder: async () => {
      throw new Error(DIRECT_ORDERS_MESSAGE);
    },
    engine: async () => engine.snapshot(),
    engineRefresh: async () => {
      await engine.refresh();
      return engine.snapshot();
    },
    engineConfig: async (patch: Partial<EngineConfig>) => {
      await engine.updateConfig(patch);
      return engine.snapshot();
    },
    engineBacktest: async () => {
      if (!engine.candles.length) await engine.refresh();
      return engine.backtest();
    },
    engineResetJournal: async () => {
      await engine.resetJournal();
      return engine.snapshot();
    },
    dispose: () => {
      engine.stop();
      token.stop();
      service.stop();
    },
  };
}

/** First-time check before saving credentials: token + a NIFTY quote. */
export async function verifyDhanCredentials(clientId: string, accessToken: string, baseUrl?: string) {
  const dhan = new DhanClient({ clientId, accessToken, baseUrl });
  await dhan.profile();
  const q = await dhan.quote({ IDX_I: [13] });
  const lp = q?.data?.IDX_I?.['13']?.last_price;
  if (!lp) throw new Error('Connected, but Dhan returned no NIFTY price (check your data plan).');
  return lp as number;
}
