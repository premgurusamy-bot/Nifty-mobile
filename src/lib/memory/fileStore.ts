/**
 * Market Memory storage on the phone: one JSON file per day in the app's documents folder
 * (market-memory/YYYY-MM-DD.json). App only (expo-file-system).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { MarketMemory, type DayFile, type MemoryStore } from './recorder';

function dir(): Directory {
  const d = new Directory(Paths.document, 'market-memory');
  if (!d.exists) d.create({ intermediates: true });
  return d;
}

export function fileStore(): MemoryStore {
  return {
    load: async (day) => {
      const f = new File(dir(), `${day}.json`);
      if (!f.exists) return null;
      return JSON.parse(await f.text()) as DayFile;
    },
    save: async (file) => {
      const f = new File(dir(), `${file.day}.json`);
      if (!f.exists) f.create();
      await f.write(JSON.stringify(file));
    },
    days: async () =>
      dir()
        .list()
        .filter((x) => x instanceof File && /^\d{4}-\d{2}-\d{2}\.json$/.test(x.name))
        .map((x) => x.name.slice(0, 10)),
    remove: async (day) => {
      const f = new File(dir(), `${day}.json`);
      if (f.exists) f.delete();
    },
  };
}

/** The app's one Market Memory (recording happens only with live data on this phone). */
export const marketMemory = new MarketMemory(fileStore());

const ENABLED_KEY = 'nifty/memory/enabled';
AsyncStorage.getItem(ENABLED_KEY)
  .then((v) => {
    if (v === '0') marketMemory.enabled = false;
  })
  .catch(() => {});

/** Recording on / off (kept on the phone). */
export async function setMemoryEnabled(on: boolean) {
  marketMemory.enabled = on;
  await AsyncStorage.setItem(ENABLED_KEY, on ? '1' : '0');
}
