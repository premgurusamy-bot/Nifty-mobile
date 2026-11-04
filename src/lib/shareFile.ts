/**
 * Save text as a file and open the share sheet (WhatsApp, Gmail, Drive, Files…).
 * On the web build it downloads the file instead.
 */
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

export async function shareTextFile(name: string, content: string, mimeType: string): Promise<void> {
  if (Platform.OS === 'web') {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return;
  }
  const file = new File(Paths.cache, name);
  if (file.exists) file.delete();
  file.create();
  await file.write(content);
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this phone');
  await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: `Share ${name}` });
}
