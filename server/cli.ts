/// <reference types="node" />
/**
 * Server helper commands (run from the repo root):
 *
 *   npm run check        verify the Dhan credentials in server/.env against the live API
 *   npm run set-token    paste a new Dhan access token into server/.env (hidden input)
 */
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { NIFTY_DHAN_ID } from '../src/lib/instruments.ts';
import { DhanClient } from './dhan.ts';
import { loadEnvFile } from './index.ts';
import { mapEngineChain, mapExpiries } from './mapping.ts';
import { parseTokenValidity, writeEnvValue } from './tokenKeeper.ts';

const ENV = 'server/.env';

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    out._writeToOutput = (s: string) => {
      if (s.includes(question)) out.output.write(s);
      else out.output.write('*');
    };
    rl.question(question, (a) => {
      rl.close();
      process.stdout.write('\n');
      resolve(a.trim());
    });
  });
}

async function check() {
  loadEnvFile(ENV);
  const clientId = process.env.DHAN_CLIENT_ID;
  const token = process.env.DHAN_ACCESS_TOKEN;
  if (!clientId || !token) {
    console.error(`DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN missing in ${ENV}`);
    process.exit(1);
  }
  const dhan = new DhanClient({ clientId, accessToken: token, baseUrl: process.env.DHAN_BASE_URL });
  let failed = false;
  const step = async (name: string, fn: () => Promise<string>) => {
    try {
      console.log(`✔ ${name}: ${await fn()}`);
    } catch (e) {
      failed = true;
      console.log(`✘ ${name}: ${(e as Error).message}`);
    }
  };
  await step('Token (profile)', async () => {
    const p = await dhan.profile();
    const v = parseTokenValidity(p?.tokenValidity);
    return `client ${p?.dhanClientId ?? clientId}${v ? `, valid until ${new Date(v).toISOString()}` : ''}${p?.dataPlan ? `, data plan ${p.dataPlan}` : ''}`;
  });
  await step('NIFTY quote', async () => {
    const q = await dhan.quote({ IDX_I: [Number(NIFTY_DHAN_ID)] });
    const lp = q?.data?.IDX_I?.[NIFTY_DHAN_ID]?.last_price;
    if (!lp) throw new Error(`unexpected response ${JSON.stringify(q).slice(0, 200)}`);
    return `NIFTY ${lp}`;
  });
  let expiry = '';
  await step('Expiry list', async () => {
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const list = mapExpiries(await dhan.expiryList(Number(NIFTY_DHAN_ID), 'IDX_I')).filter((e) => e >= today);
    if (!list.length) throw new Error('no upcoming expiries returned');
    expiry = list[0];
    return list.slice(0, 3).join(', ');
  });
  if (expiry) {
    await step('Option chain', async () => {
      const c = mapEngineChain(await dhan.optionChain(Number(NIFTY_DHAN_ID), 'IDX_I', expiry), expiry);
      if (!c.strikes.length) throw new Error('empty chain');
      const greeks = c.strikes.some((s) => s.ce?.delta || s.pe?.delta);
      return `${c.strikes.length} strikes, spot ${c.spot}${greeks ? ', Greeks present' : ', no Greeks (check data plan)'}`;
    });
  }
  console.log(failed ? '\nSome checks failed — see above.' : '\nAll Dhan checks passed.');
  process.exit(failed ? 1 : 0);
}

async function setToken() {
  if (!existsSync(ENV)) {
    console.error(`${ENV} not found — run server/setup.sh first (or copy server/.env.example).`);
    process.exit(1);
  }
  const token = await askHidden('New Dhan access token: ');
  if (token.length < 20) {
    console.error('That does not look like a Dhan access token.');
    process.exit(1);
  }
  writeEnvValue(ENV, 'DHAN_ACCESS_TOKEN', token);
  console.log(`Saved to ${ENV}. Restart the server:  sudo systemctl restart nifty-trader`);
}

const cmd = process.argv[2];
if (cmd === 'check') void check();
else if (cmd === 'set-token') void setToken();
else {
  console.log('usage: node server/cli.ts check | set-token');
  process.exit(1);
}
