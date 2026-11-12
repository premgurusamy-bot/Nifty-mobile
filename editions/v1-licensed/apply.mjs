// Turns a checkout of the v1.0 release into the licensed copy "Nifty Trader v1":
//   node apply.mjs <v1 checkout dir> <this repo's dir>
// - adds the license lock (src/components/LicenseGate.tsx) around the whole app
// - adds the shared license code and the owner's public key
// - its own name / package id, so it installs next to the other apps
// tweetnacl is installed by the workflow (npm install --no-save tweetnacl@1.0.3).
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const [v1, src] = process.argv.slice(2);
if (!v1 || !src) throw new Error('usage: node apply.mjs <v1 dir> <source dir>');

copyFileSync(join(src, 'src/lib/license.ts'), join(v1, 'src/lib/license.ts'));
copyFileSync(join(src, 'src/lib/licensePublicKey.ts'), join(v1, 'src/lib/licensePublicKey.ts'));
copyFileSync(join(src, 'editions/v1-licensed/LicenseGate.tsx'), join(v1, 'src/components/LicenseGate.tsx'));

// ---- Audit fixes J-1, J-2, J-4 (live order safety) and J-3 (settings revision), as in v2 ----
copyFileSync(join(src, 'server/orderSafety.ts'), join(v1, 'server/orderSafety.ts'));
copyFileSync(join(src, 'editions/v1-licensed/liveTrader.ts'), join(v1, 'server/liveTrader.ts'));
/** Replace `from` (must occur exactly once, unless `to` is already there) in a v1 file. */
function patch(file, from, to) {
  const path = join(v1, file);
  const text = readFileSync(path, 'utf8');
  if (text.includes(to)) return;
  if (text.split(from).length !== 2) throw new Error(`${file}: expected text not found once: ${from.slice(0, 60)}`);
  writeFileSync(path, text.replace(from, to));
}
// The stop order's trigger and quantity as placed (optional: older saved positions have none).
patch(
  'src/lib/engine/types.ts',
  '  /** Exchange-side stop-loss order protecting the remaining quantity. */\n  slOrderId: string | null;\n}',
  '  /** Exchange-side stop-loss order protecting the remaining quantity. */\n  slOrderId: string | null;\n  /** Trigger and quantity of that stop order as placed. */\n  slTrigger?: number;\n  slQty?: number;\n}',
);
// J-3: every config this licensed app ever saved was written at the current revision (it never
// had older builds), so a missing revision means "current" — never re-run the migration.
patch('src/lib/engine/runner.ts', '  const rev = saved.configRev ?? 0;', '  const rev = saved.configRev ?? CONFIG_REV;');

// ---- "Clear block": lift today's no-revenge-trade block (same as v2) ----
patch(
  'src/lib/engine/decision.ts',
  `function todayHasLoggedLoss(s: EngineState): boolean {
  return s.journal.some((j) => j.date === s.day && j.pnl != null && j.pnl < 0);
}`,
  `/** Losing trades logged today. */
export function lossesToday(s: Pick<EngineState, 'journal' | 'day'>): number {
  return s.journal.filter((j) => j.date === s.day && j.pnl != null && j.pnl < 0).length;
}

/**
 * No-revenge-trade rule: a loss logged today blocks new entries — unless you cleared the block
 * (Dashboard → Clear block) after those losses; a loss after the clear blocks again.
 */
export function todayHasLoggedLoss(s: Pick<EngineState, 'journal' | 'day' | 'lossBlockCleared'>): boolean {
  const cleared = s.lossBlockCleared && s.lossBlockCleared.day === s.day ? s.lossBlockCleared.losses : 0;
  return lossesToday(s) > cleared;
}`,
);
patch(
  'src/lib/engine/types.ts',
  '  cycleLog?: CycleLogRow[];\n}',
  '  cycleLog?: CycleLogRow[];\n  /** No-revenge-trade block cleared by you for `day` (its first `losses` losses no longer block). */\n  lossBlockCleared?: { day: string; losses: number };\n}',
);
patch('src/lib/engine/runner.ts', '  closeOpenPosition,\n', '  closeOpenPosition,\n  lossesToday,\n  todayHasLoggedLoss,\n');
patch(
  'src/lib/engine/runner.ts',
  '  async resetJournal() {',
  `  /** The no-revenge-trade rule is blocking new entries now (a loss today, not cleared). */
  lossBlocked(): boolean {
    return todayHasLoggedLoss(this.state);
  }

  /** Clear today's no-revenge-trade block: the losses so far stop blocking (a new loss blocks again). */
  async clearLossBlock() {
    const losses = lossesToday(this.state);
    if (!this.lossBlocked()) throw new Error(losses ? 'The block is already cleared for today.' : 'No loss logged today — nothing to clear.');
    const ev = { kind: 'INFO' as const, message: \`No-revenge-trade block cleared by you (\${losses} loss\${losses > 1 ? 'es' : ''} today) — a new loss today blocks again\`, at: this.clock() };
    this.state = {
      ...this.state,
      lossBlockCleared: { day: this.state.day, losses },
      blockedReason: /No-revenge/.test(this.state.blockedReason) ? '' : this.state.blockedReason,
      events: [ev, ...this.state.events].slice(0, 100),
    };
    await this.store.save(this.state, this.config);
  }

  async resetJournal() {`,
);
patch('src/lib/engine/runner.ts', '  demo: boolean;\n', '  demo: boolean;\n  /** The no-revenge-trade rule is blocking entries now (Dashboard shows "Clear block"). */\n  lossBlock?: { losses: number };\n');
patch('src/lib/engine/runner.ts', '      demo,\n', '      ...(this.lossBlocked() ? { lossBlock: { losses: lossesToday(this.state) } } : {}),\n      demo,\n');
patch(
  'src/api/localApi.ts',
  '  /** Register (or replace) the PRIMARY whitelisted IP at Dhan. */',
  "  /** Clear today's no-revenge-trade block. */\n  engineClearLossBlock: () => Promise<EngineSnapshot>;\n  /** Register (or replace) the PRIMARY whitelisted IP at Dhan. */",
);
patch(
  'src/api/localApi.ts',
  '    engineResetJournal: async () => {',
  '    engineClearLossBlock: async () => {\n      await engine.clearLossBlock();\n      return engine.snapshot();\n    },\n    engineResetJournal: async () => {',
);
patch(
  'src/state/EngineContext.tsx',
  '  preflight: () => Promise<PreflightResult>;\n',
  "  preflight: () => Promise<PreflightResult>;\n  /** Clear today's no-revenge-trade block. */\n  clearLossBlock: () => Promise<void>;\n",
);
patch(
  'src/state/EngineContext.tsx',
  '  const preflight = useCallback(async () => {',
  `  const clearLossBlock = useCallback(
    () =>
      run(async () => {
        if (phoneApi) return phoneApi.engineClearLossBlock();
        if (api) throw new Error('Clearing the block runs on the phone (not through a server).');
        const r = demo.current!;
        await r.clearLossBlock();
        return r.snapshot(true);
      }),
    [api, phoneApi, run],
  );

  const preflight = useCallback(async () => {`,
);
patch('src/state/EngineContext.tsx', '      preflight,\n      screener,\n    }),', '      preflight,\n      screener,\n      clearLossBlock,\n    }),');
patch('src/state/EngineContext.tsx', '      preflight,\n      screener,\n    ],', '      preflight,\n      screener,\n      clearLossBlock,\n    ],');
patch(
  'src/app/(tabs)/index.tsx',
  'exit, setTradeMode } = useEngine();',
  'exit, setTradeMode, clearLossBlock } = useEngine();',
);
patch(
  'src/app/(tabs)/index.tsx',
  '      {/* Trade mode: PAPER',
  `      {snap.lossBlock ? (
        <Card style={{ gap: 8, borderWidth: 1, borderColor: colors.down }}>
          <Text style={[ui.sectionTitle, { marginTop: 0, color: colors.down }]}>New trades blocked</Text>
          <Text style={ui.muted}>
            No-revenge-trade rule: {snap.lossBlock.losses} losing trade{snap.lossBlock.losses > 1 ? 's' : ''} today. If the loss came
            from a mistake (e.g. a wrongly set limit), clear the block to trade again today. A new loss today blocks again; the
            daily max loss and trade limit still apply.
          </Text>
          <Button
            label="Clear block"
            color={colors.down}
            disabled={busy}
            onPress={() =>
              confirmDialog(
                'Clear the no-revenge block?',
                'New entries (manual and automatic) are allowed again today. Another loss today blocks them again. The daily max loss and trade limit still apply.',
                'Clear block',
                () => void clearLossBlock().catch((e) => setTradeMsg((e as Error).message)),
              )
            }
          />
        </Card>
      ) : null}
      {/* Trade mode: PAPER`,
);

// ---- Market Memory: the same module, screen and engine hooks as v2 ----
execFileSync(process.execPath, [join(src, 'editions/market-memory/apply.mjs'), v1, src], { stdio: 'inherit' });

const layoutPath = join(v1, 'src/app/_layout.tsx');
let layout = readFileSync(layoutPath, 'utf8');
if (!layout.includes('LicenseGate')) {
  const open = '      <SettingsProvider>';
  const close = '      </SettingsProvider>';
  if (!layout.includes(open) || !layout.includes(close)) throw new Error('_layout.tsx: SettingsProvider not found');
  layout = `import { LicenseGate } from '../components/LicenseGate';\n${layout}`
    .replace(open, `      <LicenseGate>\n${open}`)
    .replace(close, `${close}\n      </LicenseGate>`);
  writeFileSync(layoutPath, layout);
}

const appPath = join(v1, 'app.json');
const app = JSON.parse(readFileSync(appPath, 'utf8'));
app.expo.name = 'Nifty Trader v1';
app.expo.slug = 'nifty-mobile';
app.expo.scheme = 'niftytraderv1l';
app.expo.android.package = 'com.premgurusamy.niftytrader.v1licensed';
writeFileSync(appPath, `${JSON.stringify(app, null, 2)}\n`);
console.log('Licensed v1 ready:', app.expo.name, app.expo.android.package);
