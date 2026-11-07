import Constants from 'expo-constants';
import { startActivityAsync, ActivityAction } from 'expo-intent-launcher';
import { useState } from 'react';
import { Platform, StyleSheet, Switch, Text, View } from 'react-native';
import { BUILT_IN_SOUNDS, CATEGORY_LABELS, type AlertCategory, type VolumeLevel } from '../lib/alerts';
import { useAlerts } from '../state/AlertsContext';
import { colors } from '../theme';
import { Button, Card, Segmented, styles as ui } from './ui';

function Row({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={s.row}>
      <Text style={s.label}>{label}</Text>
      <Switch value={value} onValueChange={onChange} accessibilityLabel={label} />
    </View>
  );
}

/** Settings card: alert message, sound (volume + built-in / custom tone), vibration, which events. */
export function AlertSettingsCard() {
  const { prefs, update, setCategory, pickCustom, test, bg, setBackground } = useAlerts();
  const [msg, setMsg] = useState<string | null>(null);

  const pick = async () => {
    setMsg(null);
    try {
      const name = await pickCustom();
      if (name) setMsg(`Custom sound set: ${name}`);
    } catch (e) {
      setMsg(`Failed: ${(e as Error).message}`);
    }
  };

  const battery = async () => {
    setMsg(null);
    try {
      await startActivityAsync(ActivityAction.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, {
        // This app's own package (v1 and v2 are separate apps).
        data: `package:${Constants.expoConfig?.android?.package ?? 'com.premgurusamy.niftytrader.v2'}`,
      });
    } catch {
      // Some phones don't offer the direct prompt: open the full list instead.
      await startActivityAsync(ActivityAction.IGNORE_BATTERY_OPTIMIZATION_SETTINGS).catch((e) =>
        setMsg(`Failed: ${(e as Error).message}`),
      );
    }
  };

  const tones = [
    ...BUILT_IN_SOUNDS,
    ...(prefs.customUri ? [{ value: 'custom' as const, label: 'Custom' }] : []),
  ];

  return (
    <Card style={{ gap: 12 }}>
      <Text style={[ui.sectionTitle, { marginTop: 0 }]}>Run in background</Text>
      {bg.supported ? (
        <>
          <Row
            label="Keep watching when I use other apps or the screen is off"
            value={prefs.background}
            onChange={(v) => void setBackground(v).catch((e) => setMsg(`Failed: ${(e as Error).message}`))}
          />
          <Text style={{ color: bg.running ? colors.up : colors.muted, fontWeight: '600' }}>
            {bg.running ? 'Running in background — see the "watching the market" notification' : 'Not running'}
          </Text>
          {bg.error ? <Text style={{ color: colors.down }}>Couldn&apos;t start: {bg.error}</Text> : null}
          {bg.notifications === false ? (
            <Text style={{ color: colors.down }}>
              Notifications are blocked — allow them for Nifty Trader in Android Settings → Apps → Notifications, or
              alerts can&apos;t pop up over other apps.
            </Text>
          ) : null}
          <Button label="Allow unrestricted battery use…" color={colors.cardAlt} onPress={() => void battery()} />
          <Text style={[ui.muted, { fontSize: 12 }]}>
            Turning this on also turns auto-refresh on. Alerts then pop up over any app and on the lock screen, with
            your sound. Leave the app with Home or the app switcher — don&apos;t swipe it away from recent apps (that
            closes it; you&apos;ll get a &quot;stopped watching&quot; alert). On Xiaomi / Oppo / Vivo / Realme /
            OnePlus phones also allow &quot;Autostart&quot; and set battery to &quot;No restrictions&quot; for the
            app.
          </Text>
        </>
      ) : (
        <Text style={ui.muted}>
          {Platform.OS === 'web' ? 'Available in the Android app.' : 'Available in the Android app only.'}
        </Text>
      )}

      <Text style={[ui.sectionTitle]}>Alerts (this phone)</Text>
      <Row label="Alerts on" value={prefs.enabled} onChange={(v) => void update({ enabled: v })} />
      {prefs.enabled ? (
        <>
          <Row label="Show alert message" value={prefs.popup} onChange={(v) => void update({ popup: v })} />
          <Row label="Play sound" value={prefs.sound} onChange={(v) => void update({ sound: v })} />
          {prefs.sound ? (
            <>
              <Text style={s.label}>Volume</Text>
              <Segmented
                options={[
                  { label: 'Low', value: 'LOW' as VolumeLevel },
                  { label: 'Medium', value: 'MEDIUM' as VolumeLevel },
                  { label: 'High', value: 'HIGH' as VolumeLevel },
                ]}
                value={prefs.volume}
                onChange={(v) => void update({ volume: v })}
              />
              <Text style={s.label}>Sound</Text>
              <Segmented options={tones} value={prefs.tone} onChange={(v) => void update({ tone: v })} />
              <Button label="Pick custom sound from phone…" color={colors.cardAlt} onPress={() => void pick()} />
              {prefs.customUri ? (
                <Text style={ui.muted}>
                  Custom: {prefs.customName}
                  {prefs.tone === 'custom' ? ' (in use)' : ''}
                </Text>
              ) : null}
            </>
          ) : null}
          <Row label="Vibrate" value={prefs.vibrate} onChange={(v) => void update({ vibrate: v })} />
          <Text style={s.label}>Alert me for</Text>
          {(Object.keys(CATEGORY_LABELS) as AlertCategory[]).map((c) => (
            <Row key={c} label={CATEGORY_LABELS[c]} value={prefs.categories[c]} onChange={(v) => void setCategory(c, v)} />
          ))}
          <Button label="Test alert" onPress={test} />
          <Text style={[ui.muted, { fontSize: 12 }]}>
            Volume is relative to the phone&apos;s media volume. With &quot;Run in background&quot; off, alerts only
            play while the app is on screen.
          </Text>
        </>
      ) : null}
      {msg ? <Text style={{ color: msg.startsWith('Failed') ? colors.down : colors.up }}>{msg}</Text> : null}
    </Card>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  label: { color: colors.muted, fontSize: 13, flexShrink: 1 },
});
