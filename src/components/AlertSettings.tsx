import { useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
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
  const { prefs, update, setCategory, pickCustom, test } = useAlerts();
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

  const tones = [
    ...BUILT_IN_SOUNDS,
    ...(prefs.customUri ? [{ value: 'custom' as const, label: 'Custom' }] : []),
  ];

  return (
    <Card style={{ gap: 12 }}>
      <Text style={[ui.sectionTitle, { marginTop: 0 }]}>Alerts (this phone)</Text>
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
            Volume is relative to the phone&apos;s media volume. Alerts play while the app is open (that&apos;s when the
            engine refreshes) — keep the screen on during trading.
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
