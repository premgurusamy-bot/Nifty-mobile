/**
 * Live Dhan data for the engine.
 *  - Index options: FetchIntraday (5-min index candles) + FetchOptionChain.
 *  - MCX futures: the current-month contract (resolved from Dhan's instrument
 *    list), its 5-min candles with open interest, and a live quote for LTP.
 * No Node-only imports: used by the server and by the app's direct-to-Dhan mode.
 */
import type { EngineDataSource, FuturesContract } from '../src/lib/engine/runner.ts';
import { ContractResolver, COMPACT_MASTER_URL } from './contracts.ts';
import type { EngineConfig } from '../src/lib/engine/types.ts';
import { istDateString, toIST } from '../src/lib/time.ts';
import type { DhanClient } from './dhan.ts';
import { mapCandles, mapEngineChain, mapExpiries } from './mapping.ts';

const pad = (n: number) => String(n).padStart(2, '0');
const istStamp = (ms: number) => {
  const d = toIST(ms);
  return `${istDateString(ms)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};

export class DhanEngineSource implements EngineDataSource {
  private dhan: DhanClient;
  private expiryCache = new Map<string, { at: number; value: string }>();
  private contracts: ContractResolver;
  constructor(dhan: DhanClient, contracts?: ContractResolver) {
    this.dhan = dhan;
    this.contracts =
      contracts ??
      new ContractResolver({
        fetchSegmentCsv: () => dhan.instrumentCsv('MCX_COMM'),
        fetchCompactCsv: async () => {
          const r = await fetch(COMPACT_MASTER_URL);
          if (!r.ok) throw new Error(`scrip master HTTP ${r.status}`);
          return r.text();
        },
      });
  }

  /** Current MCX contract: the saved one while it's still valid, otherwise resolve (and roll). */
  private async contract(cfg: EngineConfig, now: number): Promise<FuturesContract> {
    const cutoff = istDateString(now + cfg.rollDays * 86400_000);
    if (cfg.futSecurityId && (!cfg.futExpiry || cfg.futExpiry >= cutoff)) {
      return { securityId: cfg.futSecurityId, expiry: cfg.futExpiry, tradingSymbol: cfg.futTradingSymbol };
    }
    return this.contracts.resolve(cfg.symbol, now, cfg.rollDays);
  }

  private async loadFutures(cfg: EngineConfig, now: number) {
    const contract = await this.contract(cfg, now);
    const candlesJson = await this.dhan.intraday({
      securityId: contract.securityId,
      exchangeSegment: 'MCX_COMM',
      instrument: 'FUTCOM',
      interval: 5,
      oi: true,
      fromDate: istStamp(now - 3 * 86400_000),
      toDate: istStamp(now),
    });
    const candles = mapCandles(candlesJson);
    if (!candles.length) throw new Error(`Dhan returned no candles for ${contract.tradingSymbol || cfg.symbol}`);
    // Live price for SL/target checks (the latest 5-min bar can be up to 5 minutes old).
    let spot = candles[candles.length - 1].c;
    try {
      const q = await this.dhan.quote({ MCX_COMM: [Number(contract.securityId)] });
      const lp = Number(q?.data?.MCX_COMM?.[contract.securityId]?.last_price);
      if (lp > 0) spot = lp;
    } catch {
      /* fall back to the last candle close */
    }
    return { candles, chain: { spot, expiry: contract.expiry, strikes: [] }, contract };
  }

  /** GetNearestExpiry: manual override, else first expiry Dhan lists. */
  private async expiry(cfg: EngineConfig, now: number): Promise<string> {
    if (cfg.expiry) return cfg.expiry;
    const key = `${cfg.underlyingSecurityId}:${cfg.underlyingSegment}`;
    const hit = this.expiryCache.get(key);
    const today = istDateString(now);
    if (hit && now - hit.at < 30 * 60_000 && hit.value >= today) return hit.value;
    const list = mapExpiries(await this.dhan.expiryList(cfg.underlyingSecurityId, cfg.underlyingSegment)).filter(
      (e) => e >= today,
    );
    if (!list.length) throw new Error('Dhan returned no upcoming expiries');
    this.expiryCache.set(key, { at: now, value: list[0] });
    return list[0];
  }

  async load(cfg: EngineConfig, now: number) {
    if (cfg.instrumentKind === 'MCX_FUTURES') return this.loadFutures(cfg, now);
    const expiry = await this.expiry(cfg, now);
    // FetchIntraday: last 3 days of 5-minute candles.
    const candlesJson = await this.dhan.intraday({
      securityId: String(cfg.underlyingSecurityId),
      exchangeSegment: cfg.underlyingSegment,
      instrument: cfg.underlyingSegment === 'IDX_I' ? 'INDEX' : 'EQUITY',
      interval: 5,
      fromDate: istStamp(now - 3 * 86400_000),
      toDate: istStamp(now),
    });
    const candles = mapCandles(candlesJson);
    if (!candles.length) throw new Error('Dhan returned no intraday candles');
    const chain = mapEngineChain(
      await this.dhan.optionChain(cfg.underlyingSecurityId, cfg.underlyingSegment, expiry),
      expiry,
    );
    if (!chain.strikes.length) throw new Error(`Option chain for ${expiry} is empty`);
    return { candles, chain };
  }
}
