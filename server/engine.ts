/// <reference types="node" />
/**
 * Runs the option-buying engine on the server against live Dhan data,
 * persisting state like the workbook's auto-managed sheets.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { EngineStore } from '../src/lib/engine/runner.ts';
import type { EngineConfig, EngineEvent, EngineState } from '../src/lib/engine/types.ts';
export { DhanEngineSource } from './engineSource.ts';

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
