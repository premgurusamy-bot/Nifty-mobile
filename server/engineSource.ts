/**
 * Live Dhan data for the option-buying engine (FetchIntraday + FetchOptionChain).
 * No Node-only imports: used by the server and by the app's direct-to-Dhan mode.
 */
import type { EngineDataSource } from '../src/lib/engine/runner.ts';
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
  constructor(dhan: DhanClient) {
    this.dhan = dhan;
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
