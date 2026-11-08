/// <reference types="node" />
/**
 * Nifty Trader ↔ Dhan bridge server.
 *
 * Keeps the Dhan access token off the phone, respects Dhan rate limits, and
 * exposes a small JSON API to the app. Run on a machine whose static IP is
 * whitelisted in Dhan (required by Dhan for order APIs).
 *
 *   npm run server       (Node >= 22.18; reads server/.env — see server/.env.example)
 */
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import type { PlaceOrderBody } from '../src/lib/apiTypes.ts';
import { EQUITIES } from '../src/lib/instruments.ts';
import { DhanClient, DhanError } from './dhan.ts';
import { mapFunds } from './mapping.ts';
import { loadScripMaster, SCRIP_MASTER_URL } from './scripMaster.ts';
import { DhanService, HttpError } from './service.ts';
import { EngineRunner } from '../src/lib/engine/runner.ts';
import { DhanEngineSource, FileStore, telegramNotifier } from './engine.ts';
import { dhanQuoteSource } from './engineSource.ts';
import { TokenKeeper } from './tokenKeeper.ts';
import { writeEnvValue } from './envFile.ts';

export interface ServerConfig {
  port: number;
  host: string;
  appApiKey: string;
  dhanClientId: string;
  dhanAccessToken: string;
  dhanBaseUrl: string;
  scripMasterUrl: string;
  liveOrders: boolean;
  maxOrderValue: number;
  corsOrigin: string;
  dataDir: string;
  telegramToken?: string;
  telegramChatId?: string;
  /** Env file the token keeper writes renewed tokens to (null = don't persist). */
  envPath?: string | null;
  tokenAutoRenew?: boolean;
}

export function loadEnvFile(path = '.env') {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export function configFromEnv(env = process.env): ServerConfig {
  const missing = ['DHAN_CLIENT_ID', 'DHAN_ACCESS_TOKEN', 'APP_API_KEY'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing required env vars: ${missing.join(', ')} (see server/.env.example)`);
  if (env.APP_API_KEY!.length < 16) throw new Error('APP_API_KEY must be at least 16 characters');
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '0.0.0.0',
    appApiKey: env.APP_API_KEY!,
    dhanClientId: env.DHAN_CLIENT_ID!,
    dhanAccessToken: env.DHAN_ACCESS_TOKEN!,
    dhanBaseUrl: env.DHAN_BASE_URL ?? 'https://api.dhan.co/v2',
    scripMasterUrl: env.SCRIP_MASTER_URL ?? SCRIP_MASTER_URL,
    liveOrders: env.LIVE_ORDERS === 'true',
    maxOrderValue: Number(env.MAX_ORDER_VALUE ?? 0),
    corsOrigin: env.CORS_ORIGIN ?? '*',
    dataDir: env.DATA_DIR ?? 'server/data',
    telegramToken: env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: env.TELEGRAM_CHAT_ID || undefined,
    tokenAutoRenew: env.TOKEN_AUTO_RENEW !== 'false',
  };
}

const MAX_BODY = 16 * 1024;

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function authorized(req: IncomingMessage, key: string) {
  const h = req.headers.authorization ?? '';
  const given = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
  const want = Buffer.from(key);
  return given.length === want.length && timingSafeEqual(given, want);
}

export function createApp(cfg: ServerConfig, service: DhanService, engine?: EngineRunner, token?: TokenKeeper) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': cfg.corsOrigin,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') return send(204, {});

    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (path === '/health') return send(200, { ok: true });
    if (!authorized(req, cfg.appApiKey)) return send(401, { error: 'Unauthorized' });

    try {
      if (req.method === 'GET' && path === '/api/status') {
        const st = service.status();
        if (token) {
          const t = token.status;
          st.token = { ok: t.ok, validUntil: t.validUntil, lastRenewal: t.lastRenewal, message: t.message };
          if (!t.ok && t.lastCheck) st.ok = false;
        }
        return send(200, st);
      }

      // ---- Option-buying engine (ported workbook) ----
      if (engine && path.startsWith('/api/engine')) {
        if (req.method === 'GET' && path === '/api/engine') return send(200, engine.snapshot());
        if (req.method === 'POST' && path === '/api/engine/refresh') {
          await engine.refresh();
          return send(200, engine.snapshot());
        }
        if (req.method === 'PUT' && path === '/api/engine/config') {
          try {
            await engine.updateConfig(await readJson(req));
          } catch (e) {
            if (e instanceof HttpError) throw e;
            throw new HttpError(400, (e as Error).message);
          }
          return send(200, engine.snapshot());
        }
        if (req.method === 'GET' && path === '/api/engine/backtest') {
          if (!engine.candles.length) await engine.refresh();
          return send(200, engine.backtest());
        }
        if (req.method === 'GET' && path === '/api/engine/export') {
          return send(200, engine.exportData());
        }
        if (req.method === 'POST' && path === '/api/engine/reset-journal') {
          await engine.resetJournal();
          return send(200, engine.snapshot());
        }
      }

      if (req.method === 'GET' && path === '/api/quotes') {
        const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean).slice(0, 200);
        let quotes = service.getQuotes(ids);
        if (quotes.length < ids.length) {
          await service.primeQuotes(ids);
          quotes = service.getQuotes(ids);
        }
        return send(200, { quotes });
      }

      if (req.method === 'GET' && path === '/api/intraday') {
        return send(200, { points: await service.intraday(url.searchParams.get('id') ?? '') });
      }

      if (req.method === 'GET' && path === '/api/expiries') return send(200, { expiries: await service.expiries() });

      if (req.method === 'GET' && path === '/api/optionchain') {
        return send(200, await service.optionChain(url.searchParams.get('expiry') ?? ''));
      }

      if (req.method === 'GET' && path === '/api/portfolio') return send(200, await service.portfolio());
      if (req.method === 'GET' && path === '/api/orders') return send(200, await service.orders());

      if (req.method === 'POST' && path === '/api/orders') {
        const body = (await readJson(req)) as PlaceOrderBody;
        const order = await service.placeOrder(body);
        console.log(`[order] ${body.side} ${body.qty} ${body.instrumentId} ${body.type} → ${order.id} ${order.status}`);
        return send(200, { order });
      }

      const cancel = /^\/api\/orders\/([\w-]+)$/.exec(path);
      if (req.method === 'DELETE' && cancel) {
        await service.cancelOrder(cancel[1]);
        return send(200, { ok: true });
      }

      return send(404, { error: 'Not found' });
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      if (e instanceof DhanError) {
        const status = e.status === 401 || e.code === 'DH-901' ? 502 : e.status >= 500 ? 502 : 400;
        return send(status, { error: e.message, code: e.code });
      }
      console.error(e);
      return send(500, { error: 'Internal error' });
    }
  });
}

export async function start(cfg: ServerConfig) {
  const dhan = new DhanClient({
    clientId: cfg.dhanClientId,
    accessToken: cfg.dhanAccessToken,
    baseUrl: cfg.dhanBaseUrl,
  });
  const service = new DhanService(dhan, { liveOrders: cfg.liveOrders, maxOrderValue: cfg.maxOrderValue });

  loadScripMaster(cfg.scripMasterUrl, new Set(EQUITIES.map((e) => e.symbol)))
    .then((sm) => {
      service.setScripMaster(sm);
      console.log(`[scrip] loaded ${sm.options.size} NIFTY options, lot size ${sm.niftyLotSize}`);
    })
    .catch((e) => console.warn(`[scrip] could not load scrip master (${e.message}); falling back to option-chain ids`));

  const engine = new EngineRunner(
    new DhanEngineSource(dhan),
    new FileStore(`${cfg.dataDir}/engine.json`),
    telegramNotifier(cfg.telegramToken, cfg.telegramChatId),
  );
  await engine.init();
  engine.quoteSource = dhanQuoteSource(dhan);
  engine.syncTimer();
  engine.fundsSource = async () => mapFunds(await dhan.fundLimit());

  const envPath = cfg.envPath ?? null;
  const token = new TokenKeeper(dhan, {
    autoRenew: cfg.tokenAutoRenew ?? true,
    persist: envPath ? (t) => writeEnvValue(envPath, 'DHAN_ACCESS_TOKEN', t) : undefined,
  });
  token.start();

  const server = createApp(cfg, service, engine, token);
  await new Promise<void>((r) => server.listen(cfg.port, cfg.host, r));
  console.log(
    `Nifty Trader server on http://${cfg.host}:${cfg.port} · live orders ${cfg.liveOrders ? 'ENABLED' : 'disabled'}`,
  );
  return { server, service, engine, token };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const envPath = existsSync('server/.env') ? 'server/.env' : existsSync('.env') ? '.env' : null;
  loadEnvFile('server/.env');
  loadEnvFile('.env');
  start({ ...configFromEnv(), envPath }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
