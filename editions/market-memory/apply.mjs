// Market Memory: the engine hooks, shared by v2 and the licensed v1 (same patches for both apps).
//   node editions/market-memory/apply.mjs <app dir> <this repo's dir>
// Copies the Market Memory module and screen (skipped when <app dir> is this repo) and adds:
//  - Dashboard.breakdowns (both sides' factor points; display data, no scoring change);
//  - EngineRunner.memory + a call after each cycle (index options only);
//  - LocalApiOptions.memory, set on the phone (SettingsContext) — live data only, never the demo;
//  - the "Memory" tab.
// Idempotent: a patch already applied is skipped.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [dir, src] = process.argv.slice(2);
if (!dir || !src) throw new Error('usage: node apply.mjs <app dir> <source dir>');

if (resolve(dir) !== resolve(src)) {
  mkdirSync(join(dir, 'src/lib/memory'), { recursive: true });
  for (const f of ['indicators.ts', 'recorder.ts', 'analysis.ts', 'fileStore.ts'])
    copyFileSync(join(src, 'src/lib/memory', f), join(dir, 'src/lib/memory', f));
  copyFileSync(join(src, 'src/app/(tabs)/memory.tsx'), join(dir, 'src/app/(tabs)/memory.tsx'));
}

function patch(file, from, to, optional = false) {
  const path = join(dir, file);
  const text = readFileSync(path, 'utf8');
  if (text.includes(to)) return;
  const n = text.split(from).length - 1;
  if (n !== 1) {
    if (optional && n === 0) return;
    throw new Error(`${file}: expected text ${n ? 'more than once' : 'not found'}: ${from.slice(0, 60)}`);
  }
  writeFileSync(path, text.replace(from, to));
}

patch(
  'src/lib/engine/types.ts',
  '  breakdown: ScoreBreakdown;\n',
  '  breakdown: ScoreBreakdown;\n  /** Both sides\' factor points (Market Memory records them; no effect on scoring). */\n  breakdowns?: { CE: ScoreBreakdown; PE: ScoreBreakdown };\n',
);
patch('src/lib/engine/decision.ts', '\n    breakdown,\n', '\n    breakdown,\n    breakdowns: { CE: ce.breakdown, PE: pe.breakdown },\n');

patch(
  'src/lib/engine/runner.ts',
  "import { runBacktest, type BacktestResult } from './backtest.ts';\n",
  "import { runBacktest, type BacktestResult } from './backtest.ts';\nimport type { MarketMemory } from '../memory/recorder.ts';\n",
);
patch(
  'src/lib/engine/runner.ts',
  '  dashboard: Dashboard | null = null;\n',
  '  dashboard: Dashboard | null = null;\n  /** Market Memory: records every closed 5-minute candle (live data on the phone only). */\n  memory: MarketMemory | null = null;\n',
);
patch(
  'src/lib/engine/runner.ts',
  '      this.lastChain = data.chain;\n',
  "      this.lastChain = data.chain;\n      // Market Memory: recording never disturbs trading.\n      if (this.memory && this.config.instrumentKind === 'INDEX_OPTIONS')\n        try {\n          this.memory.observe(this.config.symbol, data.candles, data.chain, dashboard, this.config.lotSize);\n        } catch {\n          /* recording only */\n        }\n",
);
// v2 multi-index cycle (absent in v1).
patch(
  'src/lib/engine/runner.ts',
  '      this.multiData = data;\n',
  '      this.multiData = data;\n      // Market Memory: recording never disturbs trading.\n      if (this.memory)\n        for (const [sym, d] of Object.entries(data))\n          try {\n            this.memory.observe(sym, d.candles, d.chain, res.dashboards[sym] ?? null, this.cfgFor(sym).lotSize);\n          } catch {\n            /* recording only */\n          }\n',
  true,
);

patch(
  'src/api/localApi.ts',
  "import { DhanClient } from '../../server/dhan.ts';\n",
  "import { DhanClient } from '../../server/dhan.ts';\nimport type { MarketMemory } from '../lib/memory/recorder.ts';\n",
);
patch(
  'src/api/localApi.ts',
  '  store: EngineStore;\n',
  "  store: EngineStore;\n  /** Market Memory to record the live candles into (the phone's). */\n  memory?: MarketMemory | null;\n",
);
patch('src/api/localApi.ts', '  await engine.init();\n', '  await engine.init();\n  engine.memory = o.memory ?? null;\n');

patch(
  'src/state/SettingsContext.tsx',
  "import { Platform } from 'react-native';\n",
  "import { Platform } from 'react-native';\nimport { marketMemory } from '../lib/memory/fileStore';\n",
);
patch('src/state/SettingsContext.tsx', '      store: directEngineStore,\n', '      store: directEngineStore,\n      memory: marketMemory,\n');

patch(
  'src/app/(tabs)/_layout.tsx',
  '      <Tabs.Screen name="journal"',
  '      <Tabs.Screen name="memory" options={{ title: \'Memory\', tabBarIcon: icon(\'analytics-outline\') }} />\n      <Tabs.Screen name="journal"',
);

if (!existsSync(join(dir, 'src/app/(tabs)/memory.tsx'))) throw new Error('memory.tsx missing');
console.log('Market Memory hooks applied');
