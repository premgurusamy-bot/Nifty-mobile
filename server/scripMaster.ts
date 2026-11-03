/// <reference types="node" />
/**
 * Dhan scrip master (instrument list) parser.
 * Compact CSV: https://images.dhan.co/api-data/api-scrip-master.csv
 *
 * Gives us: NIFTY option security ids + current lot size, and NSE equity ids.
 * Columns are located by header name so ordering changes don't break parsing.
 */
import { optionId } from '../src/lib/instruments.ts';

export const SCRIP_MASTER_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';

export interface ScripMaster {
  /** app option id -> Dhan security id */
  options: Map<string, string>;
  /** Dhan NSE_FNO security id -> app option id */
  optionsBySecurityId: Map<string, string>;
  /** NSE equity trading symbol -> security id */
  equities: Map<string, string>;
  niftyLotSize: number | null;
}

export function splitCsvLine(line: string): string[] {
  if (!line.includes('"')) return line.split(',');
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

export function parseScripMaster(csv: string, wantedEquities: Set<string>): ScripMaster {
  const lines = csv.split(/\r?\n/);
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`Scrip master missing column ${name}`);
    return i;
  };
  const EXCH = col('SEM_EXM_EXCH_ID');
  const SEG = col('SEM_SEGMENT');
  const SID = col('SEM_SMST_SECURITY_ID');
  const INSTR = col('SEM_INSTRUMENT_NAME');
  const TSYM = col('SEM_TRADING_SYMBOL');
  const LOT = col('SEM_LOT_UNITS');
  const EXP = col('SEM_EXPIRY_DATE');
  const STRIKE = col('SEM_STRIKE_PRICE');
  const OPT = col('SEM_OPTION_TYPE');

  const sm: ScripMaster = {
    options: new Map(),
    optionsBySecurityId: new Map(),
    equities: new Map(),
    niftyLotSize: null,
  };
  const today = new Date().toISOString().slice(0, 10);

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // Cheap pre-filter before splitting: we only care about NSE rows.
    if (!line.startsWith('NSE')) continue;
    const f = splitCsvLine(line);
    if (f[EXCH] !== 'NSE') continue;
    const instr = f[INSTR];
    const tsym = f[TSYM];
    if (instr === 'OPTIDX' && tsym.startsWith('NIFTY-')) {
      const expiry = f[EXP].slice(0, 10);
      if (expiry < today) continue;
      const type = f[OPT];
      if (type !== 'CE' && type !== 'PE') continue;
      const strike = Math.round(Number(f[STRIKE]));
      const id = optionId({ underlying: 'NIFTY', expiry, strike, type });
      sm.options.set(id, f[SID]);
      sm.optionsBySecurityId.set(f[SID], id);
      const lot = Math.round(Number(f[LOT]));
      if (lot > 0) sm.niftyLotSize = lot;
    } else if (instr === 'EQUITY' && f[SEG] === 'E' && wantedEquities.has(tsym)) {
      sm.equities.set(tsym, f[SID]);
    }
  }
  return sm;
}

export async function loadScripMaster(url: string, wantedEquities: Set<string>): Promise<ScripMaster> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Scrip master download failed: HTTP ${res.status}`);
  return parseScripMaster(await res.text(), wantedEquities);
}
