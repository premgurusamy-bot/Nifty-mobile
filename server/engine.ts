/// <reference types="node" />
/**
 * Runs the option-buying engine on the server against live Dhan data,
 * persisting state like the workbook's auto-managed sheets.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { EngineDataSource, EngineStore } from '../src/lib/engine/runner.ts';
import type { EngineConfig, EngineEvent, EngineState } from '../src/lib/engine/types.ts';
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

export class FileStore implements EngineStore {
  private path: string;
  constructor(path: string) {
    this.path = path;
  }
  async load() {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as { state?: EngineState; config?: Partial<EngineConfig> };
    } catch {
      return null;
    }
  }
  async save(state: EngineState, config: EngineConfig) {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify({ state, config }));
    await rename(tmp, this.path);
  }
}

/** modAlerts.SendTelegram — only when a bot token + chat id are configured. */
export function telegramNotifier(token: string | undefined, chatId: string | undefined) {
  return (events: EngineEvent[], cfg: EngineConfig) => {
    for (const e of events) console.log(`[engine] ${e.kind}: ${e.message}`);
    if (!cfg.alertsEnabled || !token || !chatId) return;
    for (const e of events) {
      if (e.kind !== 'TRADE' && e.kind !== 'PARTIAL' && e.kind !== 'EXIT') continue;
      fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: e.message }),
      }).catch((err) => console.warn(`[telegram] ${err.message}`));
    }
  };
}
