/**
 * Android: lets the trading engine keep running with the app in the background.
 *
 * react-native-background-actions runs a headless JS task inside a foreground
 * service (the permanent "Nifty Trader is watching the market" notification),
 * which keeps the JS timers — auto-refresh, alerts — going while you use other
 * apps or the screen is off. The service is declared "specialUse" because
 * dataSync services are stopped after 6 hours a day on Android 15+.
 */
const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

const SERVICE = 'com.asterinet.react.bgactions.RNBackgroundActionsTask';

module.exports = function withBackgroundService(config) {
  config = AndroidConfig.Permissions.withPermissions(config, [
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
    'android.permission.WAKE_LOCK',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
  ]);
  return withAndroidManifest(config, (c) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(c.modResults);
    app.service = (app.service ?? []).filter((s) => s.$?.['android:name'] !== SERVICE);
    app.service.push({
      $: {
        'android:name': SERVICE,
        'android:exported': 'false',
        'android:foregroundServiceType': 'specialUse',
      },
      property: [
        {
          $: {
            'android:name': 'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE',
            'android:value': 'Watches live market data and the user\'s open trade to raise trading alerts',
          },
        },
      ],
    });
    return c;
  });
};
