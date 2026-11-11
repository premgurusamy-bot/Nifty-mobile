// Turns a checkout of the v1.0 release into the licensed copy "Nifty Trader v1":
//   node apply.mjs <v1 checkout dir> <this repo's dir>
// - adds the license lock (src/components/LicenseGate.tsx) around the whole app
// - adds the shared license code and the owner's public key
// - its own name / package id, so it installs next to the other apps
// tweetnacl is installed by the workflow (npm install --no-save tweetnacl@1.0.3).
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
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
