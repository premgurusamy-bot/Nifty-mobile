/**
 * Phone mode: the app talks to api.dhan.co itself with the client id and access
 * token saved on this device. It reuses the server's Dhan client, mapping,
 * service, engine data source, token keeper and live trader behind the same
 * interface as the server API, so every screen works unchanged.
 *
 *  - PAPER mode (default): live data, the engine paper-trades its signals,
 *    Portfolio/Orders are a paper account on live prices.
 *  - LIVE mode (only after the pre-flight check passes): ENTER/EXIT place real
 *    Dhan orders, each entry gets an exchange stop-loss, Portfolio/Orders show
 *    the Dhan account. Dhan accepts orders only from your whitelisted static IP,
 *    so the phone must be online through that IP (static-IP Wi-Fi or VPN).
 *  - The engine runs only while the app is open (Android pauses background JS).
 */
import { DhanClient } from '../../server/dhan.ts';
import { mapFunds } from '../../server/mapping.ts';
import { screenAll, type ScreenGroup, type ScreenReport } from '../lib/screener.ts';
import { DhanEngineSource, dhanQuoteSource } from '../../server/engineSource.ts';
import { AngelClient, angelFunds, type AngelSession } from '../../server/angel.ts';
import { AngelEngineSource } from '../../server/angelSource.ts';
import { RoutedEngineSource, routedQuoteSource } from '../../server/routedSource.ts';
import { AngelGateway } from '../../server/brokers.ts';
import { LiveTrader } from '../../server/liveTrader.ts';
import { extractIps, isIPv4, runPreflight, type PreflightResult } from '../../server/preflight.ts';
import { DhanService, underlyingFor } from '../../server/service.ts';
import { TokenKeeper } from '../../server/tokenKeeper.ts';
import type { StatusResponse } from '../lib/apiTypes';
import { EngineRunner, sanitizeConfig, type EngineSnapshot, type EngineStore } from '../lib/engine/runner.ts';
import type { EngineConfig, TradeMode } from '../lib/engine/types';
import type { Api } from './client';

export interface LocalApiOptions {
  clientId: string;
  accessToken: string;
  /** Where the engine's journal / IV history / position are kept on the device. */
  store: EngineStore;
  /** Called with a renewed token so it can be saved on the device. */
  persistToken?: (token: string) => void | Promise<void>;
  /** The static IP saved in Settings (read at check time). */
  staticIp?: () => string;
  /** Tests only: point at a fake Dhan / stub the public-IP lookup. */
  baseUrl?: string;
  publicIp?: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  /** Live P&L: quote the open position this often between refreshes (ms; 0 = off). */
  positionTickMs?: number;
  /** Tests only: tick even outside market hours. */
  tickAlways?: boolean;
  /** Angel One session saved on the phone (data for the indexes set to Angel One). */
  angelSession?: AngelSession | null;
  /** Called when Angel One ends the session (the phone forgets it). */
  onAngelSessionLost?: () => void;
  /** Tests only: point at a fake Angel One. */
  angelBaseUrl?: string;
}

export interface AngelStatus {
  connected: boolean;
  clientCode: string;
  /** When the session was made (ms). */
  since: number | null;
  /** Latest Angel One problem ('' when fine). */
  error: string;
}

export const DIRECT_ORDERS_MESSAGE =
  'Paper mode: switch the Dashboard to LIVE (after the pre-flight check passes) to place real Dhan orders.';

export interface PhoneTrading {
  /**
   * Manual ENTER: paper position, or a real Dhan buy + stop-loss in LIVE mode.
   * `limit` = buy price; below the premium it waits as a pending limit order.
   */
  engineEnter: (limit?: number) => Promise<EngineSnapshot>;
  /** Cancel a pending limit entry. */
  engineCancelEntry: () => Promise<EngineSnapshot>;
  /** Manual EXIT of the open position (real sell in LIVE mode). */
  engineExit: () => Promise<EngineSnapshot>;
  /** Switching to LIVE runs the pre-flight check and refuses if anything fails. */
  setTradeMode: (mode: TradeMode) => Promise<{ snapshot: EngineSnapshot; preflight: PreflightResult | null }>;
  preflight: () => Promise<PreflightResult>;
  /** Register (or replace) the PRIMARY whitelisted IP at Dhan. */
  registerStaticIp: (ip: string) => Promise<string[]>;
  dhanIps: () => Promise<string[]>;
  /** Multi-index: make a watched index the one shown / entered on (no trade or limit order open). */
  engineSetActive: (symbol: string) => Promise<EngineSnapshot>;
  /** Screen the indexes (~10 s: one option chain per 3 s) or the MCX minis on live data. */
  screener: (group?: ScreenGroup) => Promise<ScreenReport>;
  /** Use (or drop) an Angel One session for the Angel-fed indexes. */
  angelSetSession: (s: AngelSession | null) => AngelStatus;
  angelStatus: () => AngelStatus;
  /** Load BANK NIFTY (or `symbol`) once from Angel One and summarise it. */
  angelTest: (symbol?: string) => Promise<{ symbol: string; spot: number; expiry: string; strikes: number; candles: number; withOi: number; withIv: number }>;
  /** Each Angel One call checked on its own (and the public-IP header variants). */
  angelDiagnose: () => Promise<string[]>;
}

export type LocalApi = Api & PhoneTrading & {
  dispose: () => void;
  /** The engine itself (tests / diagnostics). */
  runner: EngineRunner;
};

export const isLocalApi = (a: Api | null): a is LocalApi => !!a && 'engineEnter' in a;

export async function createLocalApi(o: LocalApiOptions): Promise<LocalApi> {
  const dhan = new DhanClient({ clientId: o.clientId, accessToken: o.accessToken, baseUrl: o.baseUrl });
  const service = new DhanService(dhan, { liveOrders: false, maxOrderValue: 0 });
  // Angel One orders need the static IP registered on the SmartAPI app (the same one as Dhan's).
  const angel = new AngelClient({ baseUrl: o.angelBaseUrl, session: o.angelSession ?? null, publicIp: () => o.staticIp?.() ?? '' });
  const routed = new RoutedEngineSource(new DhanEngineSource(dhan), angel);
  routed.onAngelSessionLost = () => o.onAngelSessionLost?.();
  const engine = new EngineRunner(routed, o.store);
  await engine.init();
  const trader = new LiveTrader(dhan, service, { sleep: o.sleep, angel: new AngelGateway(angel, routed.angelSource) });
  engine.afterCycle = (before, after) => trader.afterCycle(engine, before, after);
  engine.quoteSource = routedQuoteSource(dhanQuoteSource(dhan), angel);
  const angelStatus = (): AngelStatus => ({
    connected: angel.connected,
    clientCode: angel.session?.clientCode ?? '',
    since: angel.session?.at ?? null,
    error: routed.angelError,
  });
  // CAPITAL sizing in LIVE (live capital 0): the balance at the broker the index's order goes to.
  engine.fundsSource = async (b) => (b === 'ANGEL' ? angelFunds(await angel.rms()) : mapFunds(await dhan.fundLimit()));
  engine.brokerReady = (b) => (b === 'ANGEL' ? angel.connected : true);
  // The screener's own data source (same Dhan client, so it shares the rate limits).
  const screenSource = new DhanEngineSource(dhan);

  // Live P&L: quote the open position every couple of seconds between engine refreshes.
  const idCache = new Map<string, string>();
  let ticking = false;
  const tickPosition = async () => {
    const p = engine.state.position;
    // The engine's fast ticks already quote the trade every second (and act on it).
    // (Angel One positions are priced by the engine's ticks through Angel.)
    if (ticking || !p || p.live?.broker === 'ANGEL' || engine.fastTicking() || (!o.tickAlways && !engine.marketOpen())) return;
    ticking = true;
    try {
      const key = engine.positionKey()!;
      const cfg = engine.config;
      let id = p.live?.securityId ?? idCache.get(key);
      if (!id) {
        const expiry = engine.dashboard?.expiry || cfg.futExpiry;
        id = await trader.securityIdFor(cfg, { direction: p.direction, strike: p.strike }, expiry);
        idCache.set(key, id);
      }
      const seg = cfg.tradeSegment;
      const q = await dhan.quote({ [seg]: [Number(id)] });
      const ltp = Number(q?.data?.[seg]?.[id]?.last_price);
      if (ltp > 0) engine.setMark(ltp, Date.now(), key);
    } catch {
      /* the next refresh still prices the position */
    } finally {
      ticking = false;
    }
  };
  const tickMs = o.positionTickMs ?? 2000;
  const ticker = tickMs > 0 ? setInterval(() => void tickPosition(), tickMs) : null;
  service.setLiveOrders(engine.config.tradeMode === 'LIVE');
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
  const live = () => engine.config.tradeMode === 'LIVE';
  const preflight = () =>
    runPreflight({ dhan, staticIp: o.staticIp?.() ?? '', config: engine.config, publicIp: o.publicIp });

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
    // The Option Chain tab follows the selected index; MCX futures have no option chain here.
    expiries: async () => {
      if (engine.config.instrumentKind === 'MCX_FUTURES') return { expiries: [] };
      return { expiries: await service.expiries(underlyingFor(engine.config.symbol)) };
    },
    optionChain: async (expiry) => {
      if (engine.config.instrumentKind === 'MCX_FUTURES') {
        throw new Error(
          `${engine.config.symbol} is traded as a future — no option chain. Pick an index in Settings to view one.`,
        );
      }
      return service.optionChain(expiry, underlyingFor(engine.config.symbol));
    },
    portfolio: () => service.portfolio(),
    orders: () => service.orders(),
    placeOrder: async (body) => {
      if (!live()) throw new Error(DIRECT_ORDERS_MESSAGE);
      return { order: await service.placeOrder(body) };
    },
    cancelOrder: async (id) => {
      if (!live()) throw new Error(DIRECT_ORDERS_MESSAGE);
      await service.cancelOrder(id);
      return { ok: true as const };
    },
    engine: async () => engine.snapshot(),
    engineRefresh: async () => {
      await engine.refresh();
      return engine.snapshot();
    },
    engineConfig: async (patch: Partial<EngineConfig>) => {
      // Trade mode changes go through setTradeMode (pre-flight gate).
      const { tradeMode: _ignored, ...rest } = patch;
      await engine.exclusive(() => engine.updateConfig(rest));
      return engine.snapshot();
    },
    engineBacktest: async () => {
      if (!engine.candles.length) await engine.refresh();
      return engine.backtest();
    },
    engineExport: async () => engine.exportData(),
    engineResetJournal: async () => {
      await engine.exclusive(async () => {
        const busy = engine.busySymbol();
        if (busy) throw new Error(`${busy} has an open trade or entry order — close it before clearing the journal.`);
        await engine.resetJournal();
      });
      return engine.snapshot();
    },

    // Manual actions run between engine cycles (never inside one), so they act on the index you see.
    engineEnter: async (limit?: number) => {
      if (!engine.dashboard) await engine.refresh();
      await engine.exclusive(() => (live() ? trader.enter(engine, limit) : engine.placeEntry(limit)));
      return engine.snapshot();
    },
    engineCancelEntry: async () => {
      await engine.exclusive(() => trader.cancelEntry(engine));
      return engine.snapshot();
    },
    engineExit: async () => {
      await engine.exclusive(() => trader.exit(engine));
      return engine.snapshot();
    },
    setTradeMode: async (mode) => {
      if (mode === engine.config.tradeMode) return { snapshot: engine.snapshot(), preflight: null };
      // Every watched index, not only the one shown: a LIVE trade must never end up managed as paper.
      const busy = engine.busySymbol();
      if (busy) throw new Error(`${busy} has an open trade or entry order — close it before switching between PAPER and LIVE.`);
      let pf: PreflightResult | null = null;
      if (mode === 'LIVE') {
        pf = await preflight();
        if (!pf.ok) return { snapshot: engine.snapshot(), preflight: pf };
      }
      await engine.exclusive(async () => {
        const late = engine.busySymbol(); // a trade may have opened during the pre-flight check
        if (late) throw new Error(`${late} has an open trade or entry order — close it before switching between PAPER and LIVE.`);
        await engine.updateConfig({ tradeMode: mode });
      });
      service.setLiveOrders(mode === 'LIVE');
      return { snapshot: engine.snapshot(), preflight: pf };
    },
    preflight,
    registerStaticIp: async (ip) => {
      if (!isIPv4(ip)) throw new Error(`"${ip}" is not an IPv4 address`);
      const current = extractIps(await dhan.getIP().catch(() => null));
      if (current.length) await dhan.modifyIP(ip, 'PRIMARY');
      else await dhan.setIP(ip, 'PRIMARY');
      return extractIps(await dhan.getIP());
    },
    dhanIps: async () => extractIps(await dhan.getIP()),
    engineSetActive: async (symbol: string) => {
      await engine.exclusive(() => engine.setActive(symbol));
      return engine.snapshot();
    },
    screener: (group?: ScreenGroup) =>
      screenAll({
        group,
        load: (cfg) => screenSource.load(cfg, Date.now()),
        now: () => Date.now(),
        config: engine.config,
        state: engine.state,
      }),
    angelSetSession: (s) => {
      angel.session = s;
      routed.angelError = '';
      return angelStatus();
    },
    angelStatus,
    angelDiagnose: async () =>
      angel.diagnose({ staticIp: o.staticIp?.() ?? '', phoneIp: await (o.publicIp?.() ?? Promise.resolve('')).catch(() => '') }),
    angelTest: async (symbol = 'BANKNIFTY') => {
      const cfg = sanitizeConfig({ symbol }, engine.config);
      const d = await new AngelEngineSource(angel).load(cfg, Date.now());
      return {
        symbol,
        spot: d.chain.spot,
        expiry: d.chain.expiry,
        strikes: d.chain.strikes.length,
        candles: d.candles.length,
        withOi: d.chain.strikes.filter((s) => (s.ce?.oi ?? 0) > 0 || (s.pe?.oi ?? 0) > 0).length,
        withIv: d.chain.strikes.filter((s) => (s.ce?.iv ?? 0) > 0 || (s.pe?.iv ?? 0) > 0).length,
      };
    },
    runner: engine,
    dispose: () => {
      if (ticker) clearInterval(ticker);
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
