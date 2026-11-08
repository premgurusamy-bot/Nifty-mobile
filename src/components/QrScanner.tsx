/**
 * QR scanning for the one-time setup fields (TOTP keys of Dhan and Angel One): scan with the
 * camera (e.g. the QR on your laptop screen), or pick a screenshot of the QR from the phone.
 * The scanned text goes into the field it was opened from; nothing leaves the phone.
 */
import { CameraView, scanFromURLAsync, useCameraPermissions } from 'expo-camera';
import * as DocumentPicker from 'expo-document-picker';
import { useRef, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';
import { Button } from './ui';

export function QrScanner({
  visible,
  title,
  onScan,
  onClose,
}: {
  visible: boolean;
  title: string;
  /** Called once with the QR's text; the scanner then closes. */
  onScan: (data: string) => void;
  onClose: () => void;
}) {
  const [perm, requestPerm] = useCameraPermissions();
  const [msg, setMsg] = useState<string | null>(null);
  const done = useRef(false);

  const finish = (data: string) => {
    if (done.current) return;
    done.current = true;
    onScan(data);
    onClose();
  };

  const pickImage = async () => {
    setMsg(null);
    try {
      const r = await DocumentPicker.getDocumentAsync({ type: 'image/*', copyToCacheDirectory: true });
      if (r.canceled || !r.assets?.[0]) return;
      const found = await scanFromURLAsync(r.assets[0].uri, ['qr']);
      if (found[0]?.data) finish(found[0].data);
      else setMsg('No QR code found in that image — crop the screenshot to the QR and try again.');
    } catch (e) {
      setMsg(`Couldn't read the image: ${(e as Error).message}`);
    }
  };

  const camera = Platform.OS !== 'web' && perm?.granted;
  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      onShow={() => {
        done.current = false;
        setMsg(null);
        if (perm && !perm.granted && perm.canAskAgain) void requestPerm();
      }}
    >
      <View style={st.wrap}>
        <Text style={st.title}>{title}</Text>
        {camera ? (
          <View style={st.frame}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={(r) => r.data && finish(r.data)}
            />
            <View pointerEvents="none" style={st.box} />
          </View>
        ) : (
          <View style={[st.frame, st.center]}>
            <Text style={st.note}>
              {Platform.OS === 'web'
                ? 'Camera scanning works in the Android app. You can still pick a QR image below.'
                : perm && !perm.granted && !perm.canAskAgain
                  ? 'Camera permission is off for this app — allow it in Android Settings → Apps → Nifty Trader v2 → Permissions, or pick a QR image below.'
                  : 'The camera needs your permission to scan.'}
            </Text>
            {Platform.OS !== 'web' && perm && !perm.granted && perm.canAskAgain ? (
              <Button label="Allow camera" onPress={() => void requestPerm()} />
            ) : null}
          </View>
        )}
        <Text style={st.note}>Point the camera at the QR code. It fills in the key by itself.</Text>
        <Button label="Pick a QR image / screenshot…" color={colors.cardAlt} onPress={() => void pickImage()} />
        {msg ? <Text style={{ color: colors.down }}>{msg}</Text> : null}
        <Pressable onPress={onClose} accessibilityRole="button" style={st.close}>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16 }}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

/** A "Scan QR" button that opens the scanner and hands the result to `onScan`. */
export function ScanQrButton({ title, onScan }: { title: string; onScan: (data: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button label="Scan QR code" color={colors.cardAlt} onPress={() => setOpen(true)} />
      <QrScanner visible={open} title={title} onScan={onScan} onClose={() => setOpen(false)} />
    </>
  );
}

const st = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg, padding: 16, paddingTop: 48, gap: 14 },
  title: { color: colors.text, fontSize: 20, fontWeight: '800' },
  frame: { width: '100%', aspectRatio: 1, borderRadius: 16, overflow: 'hidden', backgroundColor: colors.card },
  center: { alignItems: 'center', justifyContent: 'center', padding: 16, gap: 12 },
  box: { position: 'absolute', top: '15%', left: '15%', right: '15%', bottom: '15%', borderWidth: 3, borderColor: colors.accent, borderRadius: 12 },
  note: { color: colors.muted, fontSize: 13, textAlign: 'center' },
  close: { alignSelf: 'center', padding: 12 },
});
