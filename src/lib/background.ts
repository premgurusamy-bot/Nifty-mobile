/**
 * Background running (Android): a foreground service with a permanent notification
 * keeps the app's JS alive — the engine's auto-refresh, live-order follow-up and
 * alerts keep running while you use other apps or the screen is off.
 *
 * The app UI must stay alive in memory (press Home / switch apps; don't swipe the
 * app away). If it is closed, the service notices the missing heartbeat, posts a
 * "stopped" alert and shuts down rather than pretending to watch.
 */
import { Platform } from 'react-native';
import { notifyNow } from './notify';

type BgService = {
  start: (task: () => Promise<void>, options: Record<string, unknown>) => Promise<void>;
  stop: () => Promise<void>;
  isRunning: () => boolean;
  updateNotification: (o: { taskTitle?: string; taskDesc?: string }) => Promise<void>;
};

let svc: BgService | null | undefined;
function service(): BgService | null {
  if (svc !== undefined) return svc;
  if (Platform.OS !== 'android') return (svc = null);
  try {
    // Native module: only in the Android build (absent on web / iOS).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    svc = require('react-native-background-actions').default as BgService;
  } catch {
    svc = null;
  }
  return svc;
}

export const backgroundSupported = () => service() !== null;

let lastBeat = Date.now();
let lastDesc = '';
/** Called by the app UI while it is alive (and with the current status line). */
export function heartbeat(desc?: string) {
  lastBeat = Date.now();
  const s = service();
  if (desc && desc !== lastDesc && s?.isRunning()) {
    lastDesc = desc;
    s.updateNotification({ taskDesc: desc }).catch(() => {});
  }
}

const STALE_MS = 90_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const isBackgroundRunning = () => !!service()?.isRunning();

export async function startBackground(desc: string): Promise<void> {
  const s = service();
  if (!s) throw new Error('Background running needs the Android app');
  if (s.isRunning()) return;
  lastBeat = Date.now();
  lastDesc = desc;
  await s.start(
    async () => {
      // The headless task only has to stay alive: while it runs, Android keeps the
      // process and a wake lock, and React Native keeps firing the app's timers.
      while (s.isRunning()) {
        await sleep(10_000);
        if (Date.now() - lastBeat > STALE_MS) {
          await notifyNow({
            title: 'Nifty Trader stopped watching',
            body: 'The app was closed, so signals and stops are no longer monitored. Tap to open it again.',
            category: 'error',
          }).catch(() => {});
          await s.stop().catch(() => {});
          return;
        }
      }
    },
    {
      taskName: 'NiftyWatch',
      taskTitle: 'Nifty Trader is watching the market',
      taskDesc: desc,
      taskIcon: { name: 'notification_icon', type: 'drawable' },
      color: '#3B82F6',
      linkingURI: 'niftytrader://',
      foregroundServiceType: ['specialUse'],
    },
  );
}

export async function stopBackground(): Promise<void> {
  const s = service();
  if (s?.isRunning()) await s.stop();
}
