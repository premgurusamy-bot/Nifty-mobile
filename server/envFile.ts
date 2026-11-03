/// <reference types="node" />
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/** Replace (or append) KEY=value in an env file, atomically, keeping permissions tight. */
export function writeEnvValue(path: string, key: string, value: string) {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  let found = false;
  const next = lines.map((l) => {
    if (new RegExp(`^\\s*${key}\\s*=`).test(l)) {
      found = true;
      return `${key}=${value}`;
    }
    return l;
  });
  if (!found) next.push(`${key}=${value}`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, next.join('\n'), { mode: 0o600 });
  renameSync(tmp, path);
}
