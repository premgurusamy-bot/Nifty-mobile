/**
 * Phone alerts: which engine events raise an alert, and the user's sound preferences.
 * Pure logic (tested in node); playback lives in src/state/AlertsContext.tsx.
 */
import type { EngineEvent } from './engine/types.ts';

export type AlertCategory = 'signal' | 'entry' | 'target' | 'lock' | 'stop' | 'exit' | 'error';
export type VolumeLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type BuiltInSound = 'chime' | 'beep' | 'bell' | 'alarm';

export interface AlertPrefs {
  enabled: boolean;
  /** Pop-up message on screen. */
  popup: boolean;
  sound: boolean;
  volume: VolumeLevel;
  /** Built-in tone, or 'custom' for the file the user picked. */
  tone: BuiltInSound | 'custom';
  /** Picked sound, copied into the app's documents folder. */
  customUri: string;
  customName: string;
  vibrate: boolean;
  categories: Record<AlertCategory, boolean>;
  /** Android: keep running in the background (foreground service + pop-up notifications). */
  background: boolean;
}

export const VOLUME: Record<VolumeLevel, number> = { LOW: 0.3, MEDIUM: 0.6, HIGH: 1 };

export const BUILT_IN_SOUNDS: { value: BuiltInSound; label: string }[] = [
  { value: 'chime', label: 'Chime' },
  { value: 'beep', label: 'Beep' },
  { value: 'bell', label: 'Bell' },
  { value: 'alarm', label: 'Alarm' },
];

export const CATEGORY_LABELS: Record<AlertCategory, string> = {
  signal: 'Signal confirmed (LIVE — waits for ENTER)',
  entry: 'Trade entered (incl. limit order filled)',
  target: 'Target 1 hit (partial booked)',
  lock: 'Profit locked / loss trail raised',
  stop: 'Stop-loss hit',
  exit: 'Target 2 / other exits',
  error: 'Order errors',
};

export const DEFAULT_ALERT_PREFS: AlertPrefs = {
  enabled: true,
  popup: true,
  sound: true,
  volume: 'MEDIUM',
  tone: 'chime',
  customUri: '',
  customName: '',
  vibrate: true,
  categories: { signal: true, entry: true, target: true, lock: true, stop: true, exit: true, error: true },
  background: false,
};

/** Merge stored prefs over the defaults (older saves may lack newer fields). */
export function loadPrefs(raw: unknown): AlertPrefs {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<AlertPrefs>;
  const merged = { ...DEFAULT_ALERT_PREFS, ...p, categories: { ...DEFAULT_ALERT_PREFS.categories, ...(p.categories ?? {}) } };
  if (!(merged.volume in VOLUME)) merged.volume = 'MEDIUM';
  if (merged.tone === 'custom' && !merged.customUri) merged.tone = 'chime';
  return merged;
}

/** Category of an engine event, or null when it shouldn't alert. */
export function categoryOf(e: Pick<EngineEvent, 'kind' | 'message'>): AlertCategory | null {
  switch (e.kind) {
    case 'SIGNAL':
      return 'signal';
    case 'TRADE':
      return 'entry';
    case 'PARTIAL':
      return 'target';
    case 'INFO':
      return /profit lock|day plan|loss trail/i.test(e.message) ? 'lock' : null;
    case 'EXIT':
      if (/PROFIT LOCK|DAY FLOOR|LOSS TRAIL/i.test(e.message)) return 'lock';
      if (/\bSL\b|stop/i.test(e.message)) return 'stop';
      return /TARGET 1/i.test(e.message) ? 'target' : 'exit';
    case 'ERROR':
      return 'error';
    default:
      return null;
  }
}

export const ALERT_TITLES: Record<AlertCategory, string> = {
  signal: 'Signal confirmed',
  entry: 'Trade entered',
  target: 'Target hit',
  lock: 'Profit lock / loss trail',
  stop: 'Stop-loss hit',
  exit: 'Position closed',
  error: 'Order problem',
};

export interface AlertItem {
  key: string;
  category: AlertCategory;
  title: string;
  message: string;
  at: number;
}

const eventKey = (e: EngineEvent) => `${e.at}|${e.kind}|${e.message}`;

/**
 * Events in `events` (newest first) not seen before, as alerts the prefs allow, oldest first.
 * `seen` is updated in place; pass `prime` on the first snapshot so old events stay quiet.
 */
export function newAlerts(events: EngineEvent[], seen: Set<string>, prefs: AlertPrefs, prime = false): AlertItem[] {
  const out: AlertItem[] = [];
  for (const e of [...events].reverse()) {
    const key = eventKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    if (prime || !prefs.enabled) continue;
    const category = categoryOf(e);
    if (!category || !prefs.categories[category]) continue;
    out.push({ key, category, title: ALERT_TITLES[category], message: e.message, at: e.at });
  }
  // Keep the memory bounded (the engine itself keeps only the latest events).
  if (seen.size > 500) {
    const keep = new Set(events.map(eventKey));
    for (const k of seen) if (!keep.has(k)) seen.delete(k);
  }
  return out;
}

/** Engine status lines that report a live order failure (alerted as 'error'). */
export const isOrderErrorStatus = (status: string) =>
  /live order error|order failed|stop-loss order failed|rejected/i.test(status);

/** One-line status for the background notification ("NIFTY · PAPER · WAIT · 10:29"). */
export function statusLine(snap: {
  config: { symbol: string; tradeMode: string; autoRefresh: boolean };
  dashboard: { decision: { signal: string } } | null;
  state: { position: { direction: string; strike: number } | null };
  lastRefresh: number | null;
}): string {
  const t = snap.lastRefresh
    ? new Date(snap.lastRefresh + 5.5 * 3600_000).toISOString().slice(11, 16) + ' IST'
    : 'not refreshed';
  const pos = snap.state.position
    ? `IN ${snap.state.position.direction}${snap.state.position.strike ? ' ' + snap.state.position.strike : ''}`
    : (snap.dashboard?.decision.signal ?? '—');
  const auto = snap.config.autoRefresh ? '' : ' · AUTO-REFRESH OFF';
  return `${snap.config.symbol} · ${snap.config.tradeMode} · ${pos} · ${t}${auto}`;
}
