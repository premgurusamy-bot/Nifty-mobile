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
