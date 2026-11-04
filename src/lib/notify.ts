/**
 * System notifications for alerts raised while the app is in the background: a
 * high-importance channel, so each alert pops up over whatever app is open and
 * shows on the lock screen. The alert sound itself is played by the app (your
 * chosen tone and volume), so the channel is silent apart from vibration.
 */
import * as Notifications from 'expo-notifications';
import { AndroidImportance, AndroidNotificationVisibility } from 'expo-notifications';
import { Platform } from 'react-native';
import type { AlertCategory } from './alerts';

export const ALERT_CHANNEL = 'trade-alerts';
let ready: Promise<void> | null = null;

function setup(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
        priority: Notifications.AndroidNotificationPriority.MAX,
      }),
    });
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(ALERT_CHANNEL, {
        name: 'Trade alerts',
        description: 'Signals, entries, targets, stop-loss hits and order problems',
        importance: AndroidImportance.MAX,
        lockscreenVisibility: AndroidNotificationVisibility.PUBLIC,
        sound: null,
        enableVibrate: true,
        vibrationPattern: [0, 400, 200, 400],
        bypassDnd: true,
        showBadge: true,
      });
    }
  })().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

/** Ask for permission to show notifications (Android 13+ asks the user once). */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  await setup();
  const cur = await Notifications.getPermissionsAsync();
  if (cur.granted) return true;
  if (!cur.canAskAgain) return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}

export async function notifyNow(a: { title: string; body: string; category: AlertCategory }): Promise<void> {
  if (Platform.OS === 'web') return;
  await setup();
  await Notifications.scheduleNotificationAsync({
    content: {
      title: a.title,
      body: a.body,
      sound: false,
      priority: Notifications.AndroidNotificationPriority.MAX,
      color: a.category === 'stop' || a.category === 'error' ? '#EF4444' : '#3B82F6',
      data: { category: a.category },
    },
    trigger: Platform.OS === 'android' ? { channelId: ALERT_CHANNEL } : null,
  });
}
