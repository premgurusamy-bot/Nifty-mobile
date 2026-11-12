// Chart + Pine Script: the same screen and hooks for v2 and the licensed v1.
//   node editions/chart/apply.mjs <app dir> <this repo's dir>
// Copies the chart screen, candle chart and Pine generator (skipped when <app dir> is this repo)
// and adds: the selected index's candles to the engine snapshot, the Chart screen to the stack and a
// "Chart & Pine Script" button on the Dashboard. Needs Market Memory (editions/market-memory) first.
// Idempotent.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [dir, src] = process.argv.slice(2);
if (!dir || !src) throw new Error('usage: node apply.mjs <app dir> <source dir>');

if (resolve(dir) !== resolve(src))
  for (const f of ['src/app/chart.tsx', 'src/components/CandleChart.tsx', 'src/lib/pine.ts']) copyFileSync(join(src, f), join(dir, f));

function patch(file, from, to) {
  const path = join(dir, file);
  const text = readFileSync(path, 'utf8');
  if (text.includes(to)) return;
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(`${file}: expected text ${n ? 'more than once' : 'not found'}: ${from.slice(0, 60)}`);
  writeFileSync(path, text.replace(from, to));
}

patch(
  'src/lib/engine/runner.ts',
  '  closes: number[];\n',
  "  closes: number[];\n  /** The selected index's latest 5-minute candles (Chart screen). */\n  candles?: Candle[];\n",
);
patch(
  'src/lib/engine/runner.ts',
  '      closes: this.candles.slice(-150).map((c) => c.c),\n',
  '      closes: this.candles.slice(-150).map((c) => c.c),\n      candles: this.candles.slice(-150),\n',
);
patch(
  'src/app/_layout.tsx',
  '                <Stack.Screen name="orders" options={{ title: \'Orders\' }} />\n',
  '                <Stack.Screen name="orders" options={{ title: \'Orders\' }} />\n                <Stack.Screen name="chart" options={{ title: \'Chart & Pine Script\' }} />\n',
);
patch(
  'src/app/(tabs)/index.tsx',
  "import { useEngine } from '../../state/EngineContext';\n",
  "import { useEngine } from '../../state/EngineContext';\nimport { router } from 'expo-router';\n",
);
patch(
  'src/app/(tabs)/index.tsx',
  '      {/* Trade mode: PAPER (engine paper-trades) / LIVE (real Dhan orders via ENTER/EXIT) */}\n',
  "      <Button label=\"📈 Chart & Pine Script\" onPress={() => router.push('/chart')} color={colors.cardAlt} />\n      {/* Trade mode: PAPER (engine paper-trades) / LIVE (real Dhan orders via ENTER/EXIT) */}\n",
);
console.log('Chart + Pine Script applied');
