/**
 * The engine's data source on the phone: each index from the feed chosen for it.
 * Angel-fed indexes (config.angelSymbols) load from Angel One; when Angel isn't logged in or
 * fails, they fall back to Dhan for that refresh and the chain says why (chain.feedNote).
 */
import type { EngineDataSource } from '../src/lib/engine/runner.ts';
import type { EngineConfig } from '../src/lib/engine/types.ts';
import type { QuoteMap, QuoteSource } from '../src/lib/engine/ticks.ts';
import { AngelError, type AngelClient } from './angel.ts';
import { ANGEL_INDEX_TOKENS, AngelEngineSource, angelQuoteSource } from './angelSource.ts';

/** Angel's "session no longer valid" errors: the user has to log in again. */
const SESSION_GONE = /^AG800[1-3]$|invalid token|token expired|session/i;

export class RoutedEngineSource implements EngineDataSource {
  private dhan: EngineDataSource;
  private angel: AngelClient;
  /** Shared with the Angel One order gateway (contracts cached once). */
  readonly angelSource: AngelEngineSource;
  /** Latest Angel problem (shown in Settings), '' when fine. */
  angelError = '';
  /** Called when Angel says the session is gone (the phone forgets it). */
  onAngelSessionLost: (() => void) | null = null;

  constructor(dhan: EngineDataSource, angel: AngelClient) {
    this.dhan = dhan;
    this.angel = angel;
    this.angelSource = new AngelEngineSource(angel);
  }

  async load(cfg: EngineConfig, now: number) {
    const wantsAngel = cfg.instrumentKind === 'INDEX_OPTIONS' && (cfg.angelSymbols ?? []).includes(cfg.symbol);
    if (!wantsAngel) {
      try {
        return await this.dhan.load(cfg, now);
      } catch (e) {
        // Dhan failed: an index Angel One can serve switches to it for this refresh (switch on).
        const canAngel = cfg.instrumentKind === 'INDEX_OPTIONS' && cfg.brokerFailover !== false && this.angel.connected && !!ANGEL_INDEX_TOKENS[cfg.symbol];
        if (!canAngel) throw e;
        const d = await this.angelSource.load(cfg, now).catch(() => {
          throw e; // both failed: report Dhan's error
        });
        return { ...d, chain: { ...d.chain, feedNote: `Dhan error (${(e as Error).message}) — using Angel One` } };
      }
    }
    let note = 'Angel One not logged in — using Dhan';
    if (this.angel.connected) {
      try {
        const d = await this.angelSource.load(cfg, now);
        this.angelError = '';
        return d;
      } catch (e) {
        const err = e as AngelError;
        this.angelError = err.message;
        if (SESSION_GONE.test(err.code ?? '') || SESSION_GONE.test(err.message)) {
          this.angel.session = null;
          this.onAngelSessionLost?.();
          note = 'Angel One session ended — log in again; using Dhan';
        } else if (/AG8004|api key/i.test(`${err.code} ${err.message}`))
          // Kept logged in, so Settings → Test can show which call Angel refuses.
          note = 'Angel One refused the API key — Settings → Angel One → Test shows which call; using Dhan';
        else note = `Angel One error (${err.message}) — using Dhan`;
      }
    }
    const d = await this.dhan.load(cfg, now);
    return { ...d, chain: { ...d.chain, feed: 'DHAN' as const, feedNote: note } };
  }
}

/** Fast ticks across both feeds: ANGEL:* segments go to Angel, the rest to Dhan (in parallel). */
export function routedQuoteSource(dhan: QuoteSource, angel: AngelClient): QuoteSource {
  const viaAngel = angelQuoteSource(angel);
  return async (reqs) => {
    const a = reqs.filter((r) => r.segment.startsWith('ANGEL:'));
    const d = reqs.filter((r) => !r.segment.startsWith('ANGEL:'));
    const [qa, qd] = await Promise.all([
      a.length && angel.connected ? viaAngel(a).catch(() => ({}) as QuoteMap) : ({} as QuoteMap),
      d.length ? dhan(d).catch(() => ({}) as QuoteMap) : ({} as QuoteMap),
    ]);
    return { ...qd, ...qa };
  };
}
