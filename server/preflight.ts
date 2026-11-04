/**
 * Pre-flight check before live trading from the phone.
 * No Node-only imports: runs inside the app.
 */
import { catalogEntry, sessionLabel } from '../src/lib/engine/catalog.ts';
import { isWithinMarketHours } from '../src/lib/engine/decision.ts';
import type { EngineConfig } from '../src/lib/engine/types.ts';
import { NIFTY_DHAN_ID } from '../src/lib/instruments.ts';
import type { DhanClient } from './dhan.ts';
import { mapEngineChain, mapExpiries, mapFunds } from './mapping.ts';
import { parseTokenValidity } from './tokenKeeper.ts';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface PreflightItem {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface PreflightResult {
  at: number;
  /** True when nothing failed — live trading may be switched on. */
  ok: boolean;
  items: PreflightItem[];
  publicIp: string | null;
  whitelisted: string[];
}

const IPV4 = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g;
export const isIPv4 = (s: string) =>
  /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(s.trim());

/** Dhan's getIP response shape isn't documented in the SDK: collect every IPv4 in it. */
export function extractIps(json: unknown): string[] {
  return [...new Set(JSON.stringify(json ?? '').match(IPV4) ?? [])];
}

/** The phone's public IPv4 as the internet sees it (what Dhan sees on order requests). */
export async function fetchPublicIp(url = 'https://api.ipify.org?format=json'): Promise<string> {
  const res = await fetch(url);
  const j = await res.json();
  if (!isIPv4(String(j?.ip ?? ''))) throw new Error('could not determine public IP');
  return j.ip;
}

export interface PreflightDeps {
  dhan: DhanClient;
  staticIp: string;
  config: EngineConfig;
  publicIp?: () => Promise<string>;
  now?: number;
}

export async function runPreflight(d: PreflightDeps): Promise<PreflightResult> {
  const now = d.now ?? Date.now();
  const items: PreflightItem[] = [];
  const add = (id: string, label: string, status: CheckStatus, detail: string) =>
    items.push({ id, label, status, detail });
  const safe = async (fn: () => Promise<void>, id: string, label: string) => {
    try {
      await fn();
    } catch (e) {
      add(id, label, 'fail', (e as Error).message);
    }
  };

  await safe(
    async () => {
      const p = await d.dhan.profile();
      const v = parseTokenValidity(p?.tokenValidity);
      const left = v ? v - now : null;
      const when = v ? new Date(v + 5.5 * 3600_000).toISOString().slice(0, 16).replace('T', ' ') + ' IST' : '';
      if (left != null && left < 2 * 3600_000) add('token', 'Access token', 'warn', `Expires soon (${when})`);
      else add('token', 'Access token', 'pass', v ? `Valid until ${when}` : 'Valid');
    },
    'token',
    'Access token',
  );

  const cfg = d.config;
  const futures = cfg.instrumentKind === 'MCX_FUTURES';
  const entry = catalogEntry(cfg.symbol);

  if (futures) {
    await safe(
      async () => {
        if (!cfg.futSecurityId) throw new Error(`No ${cfg.symbol} contract yet — tap Refresh now on the Dashboard`);
        const q = await d.dhan.quote({ MCX_COMM: [Number(cfg.futSecurityId)] });
        const lp = q?.data?.MCX_COMM?.[cfg.futSecurityId]?.last_price;
        if (!lp) throw new Error(`No price for ${cfg.futTradingSymbol || cfg.symbol} (check your MCX data plan / segment activation)`);
        add('data', 'Live futures price', 'pass', `${cfg.futTradingSymbol || cfg.symbol} ${lp} · expiry ${cfg.futExpiry || '—'}`);
      },
      'data',
      'Live futures price',
    );
  } else {
    await safe(
      async () => {
        const id = String(cfg.underlyingSecurityId || NIFTY_DHAN_ID);
        const seg = cfg.underlyingSegment || 'IDX_I';
        const q = await d.dhan.quote({ [seg]: [Number(id)] });
        const lp = q?.data?.[seg]?.[id]?.last_price;
        if (!lp) throw new Error(`No ${cfg.symbol} price returned (check your Dhan data plan)`);
        add('data', 'Live market data', 'pass', `${cfg.symbol} ${lp}`);
      },
      'data',
      'Live market data',
    );

    await safe(
      async () => {
        const today = new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
        const sid = cfg.underlyingSecurityId || Number(NIFTY_DHAN_ID);
        const seg = cfg.underlyingSegment || 'IDX_I';
        const exp = cfg.expiry || mapExpiries(await d.dhan.expiryList(sid, seg)).filter((e) => e >= today)[0];
        if (!exp) throw new Error('No upcoming expiry returned');
        const chain = mapEngineChain(await d.dhan.optionChain(sid, seg, exp), exp);
        const greeks = chain.strikes.some((s) => s.ce?.delta || s.pe?.delta);
        if (!chain.strikes.length) throw new Error(`Empty option chain for ${exp}`);
        add(
          'chain',
          'Option chain + Greeks',
          greeks ? 'pass' : 'warn',
          `${cfg.symbol} ${exp}: ${chain.strikes.length} strikes${greeks ? '' : ', no Greeks'}`,
        );
      },
      'chain',
      'Option chain + Greeks',
    );
  }

  await safe(
    async () => {
      const cash = mapFunds(await d.dhan.fundLimit());
      add('funds', 'Available balance', cash > 0 ? 'pass' : 'fail', `Rs ${cash.toFixed(2)}`);
    },
    'funds',
    'Available balance',
  );

  const ip = d.staticIp.trim();
  if (!ip) add('staticip', 'Static IP entered', 'fail', 'Enter your static IP in Settings');
  else if (!isIPv4(ip)) add('staticip', 'Static IP entered', 'fail', `"${ip}" is not an IPv4 address`);
  else add('staticip', 'Static IP entered', 'pass', ip);

  let publicIp: string | null = null;
  await safe(
    async () => {
      publicIp = await (d.publicIp ?? fetchPublicIp)();
      if (!isIPv4(ip)) add('route', 'Phone is using the static IP', 'fail', `Phone's public IP is ${publicIp}`);
      else if (publicIp === ip) add('route', 'Phone is using the static IP', 'pass', publicIp);
      else
        add(
          'route',
          'Phone is using the static IP',
          'fail',
          `Phone's public IP is ${publicIp}, not ${ip}. Connect through your static-IP Wi-Fi / VPN — Dhan rejects orders from other IPs.`,
        );
    },
    'route',
    'Phone is using the static IP',
  );

  let whitelisted: string[] = [];
  try {
    whitelisted = extractIps(await d.dhan.getIP());
    if (!isIPv4(ip)) add('whitelist', 'Static IP registered with Dhan', 'fail', 'Enter a valid static IP first');
    else if (whitelisted.includes(ip))
      add('whitelist', 'Static IP registered with Dhan', 'pass', `Dhan has ${whitelisted.join(', ')}`);
    else
      add(
        'whitelist',
        'Static IP registered with Dhan',
        'fail',
        whitelisted.length
          ? `Dhan has ${whitelisted.join(', ')} — tap "Register with Dhan"`
          : 'No IP registered — tap "Register with Dhan"',
      );
  } catch (e) {
    add(
      'whitelist',
      'Static IP registered with Dhan',
      'warn',
      `Could not read Dhan's IP list: ${(e as Error).message}`,
    );
  }

  add(
    'symbol',
    'Instrument',
    entry ? 'pass' : 'fail',
    entry
      ? futures
        ? `${entry.label} futures · qty in lots · ₹${cfg.pointValue} per point per lot · tick ${cfg.tickSize}${cfg.maxLots ? ` · max ${cfg.maxLots} lot(s)` : ''}`
        : `${entry.label} options · lot ${cfg.lotSize} · strike step ${cfg.strikeInterval}`
      : `${cfg.symbol} isn't a supported instrument`,
  );
  add(
    'product',
    'Order product',
    'pass',
    d.config.liveProduct === 'INTRADAY' ? 'Intraday (Dhan squares off before close)' : 'Carry forward (NRML)',
  );
  const open = isWithinMarketHours(now, cfg.session);
  add('hours', 'Market hours', open ? 'pass' : 'warn', open ? `Open · ${sessionLabel(cfg.session, now)}` : `Closed — ${sessionLabel(cfg.session, now)}`);

  return { at: now, ok: !items.some((i) => i.status === 'fail'), items, publicIp, whitelisted };
}
