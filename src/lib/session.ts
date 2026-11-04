/**
 * Safety rules when the Dhan login changes (log in, new token, log out):
 *  - automatic LIVE entries always switch off: they need a fresh, deliberate "turn on";
 *  - a different Dhan account (client ID) goes back to PAPER, and is refused while a
 *    position from the old account is still open (the new login couldn't manage it);
 *  - logging out goes back to PAPER, refused while a LIVE position is open (its exchange
 *    stop stays at Dhan, but the app could no longer follow it).
 */
import type { EngineConfig, OpenPosition } from './engine/types.ts';

export interface SessionSnapshot {
  config: Pick<EngineConfig, 'tradeMode' | 'autoEntryLive'>;
  position: Pick<OpenPosition, 'live'> | null;
}

/** Changes to apply before a login is used, or an error explaining why it can't be. */
export function loginSafety(
  saved: SessionSnapshot | null,
  lastClientId: string | null,
  newClientId: string,
): { patch: Partial<EngineConfig>; toPaper: boolean } {
  const switched = !!lastClientId && lastClientId !== newClientId;
  if (switched && saved?.position) {
    throw new Error(
      `A position from Dhan client ${mask(lastClientId!)} is still open — log in with that account and exit it first.`,
    );
  }
  return { patch: { autoEntryLive: false }, toPaper: switched && saved?.config.tradeMode === 'LIVE' };
}

export function logoutSafety(saved: SessionSnapshot | null): { patch: Partial<EngineConfig>; toPaper: boolean } {
  if (saved?.position?.live) {
    throw new Error(
      'Exit the open LIVE position before logging out. Its stop-loss order stays at Dhan, but the app could no longer manage it.',
    );
  }
  return { patch: { autoEntryLive: false }, toPaper: saved?.config.tradeMode === 'LIVE' };
}

export const mask = (clientId: string) => clientId.replace(/.(?=.{3})/g, '•');
