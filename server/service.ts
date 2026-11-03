/// <reference types="node" />
import type {
  OptionChainResponse,
  OrdersResponse,
  PlaceOrderBody,
  PortfolioResponse,
  StatusResponse,
} from '../src/lib/apiTypes.ts';
import {
  EQUITIES,
  NIFTY_DHAN_ID,
  NIFTY_ID,
  NIFTY_LOT_SIZE,
  equityId,
  kindOf,
  parseExternalId,
  parseOptionId,
} from '../src/lib/instruments.ts';
import type { Order } from '../src/lib/portfolio.ts';
import type { Quote } from '../src/lib/simulator.ts';
import { istDateString, toIST } from '../src/lib/time.ts';
import { DhanClient, DhanError } from './dhan.ts';
import {
  dhanProductType,
  fallbackExternalId,
  mapExpiries,
  mapFunds,
  mapHoldings,
  mapIntraday,
  mapOptionChain,
  mapOrder,
  mapPositions,
  mapQuotes,
  niftyOptionIdFromDerivative,
  roundToTick,
  type InstrumentRef,
  type Resolver,
} from './mapping.ts';
import type { ScripMaster } from './scripMaster.ts';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ServiceOptions {
  liveOrders: boolean;
  /** Reject single orders above this notional value (₹). 0 disables. */
  maxOrderValue: number;
}

const QUOTE_POLL_MS = 1000;
const SUBSCRIPTION_TTL_MS = 20_000;

export class DhanService implements Resolver {
  private dhan: DhanClient;
  private opts: ServiceOptions;
  private scrip: ScripMaster | null = null;
  /** app id -> Dhan ref, for ids we've learned about (option chain, positions). */
  private learned = new Map<string, InstrumentRef>();
  private reverse = new Map<string, string>(); // `${segment}:${securityId}` -> app id

  private subscriptions = new Map<string, number>(); // id -> last requested at
  private quotes = new Map<string, Quote>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  lastError: string | null = null;

  private cache = new Map<string, { at: number; value: unknown }>();

  constructor(dhan: DhanClient, opts: ServiceOptions) {
    this.dhan = dhan;
    this.opts = opts;
    this.remember(NIFTY_ID, { segment: 'IDX_I', securityId: NIFTY_DHAN_ID });
    for (const e of EQUITIES) this.remember(equityId(e.symbol), { segment: 'NSE_EQ', securityId: e.dhanId });
  }

  /** Phone mode turns order APIs on only while the app is in LIVE trade mode. */
  setLiveOrders(on: boolean) {
    this.opts = { ...this.opts, liveOrders: on };
  }

  setScripMaster(sm: ScripMaster) {
    this.scrip = sm;
    for (const e of EQUITIES) {
      const sid = sm.equities.get(e.symbol);
      if (sid && sid !== e.dhanId) {
        console.warn(`[scrip] ${e.symbol}: built-in id ${e.dhanId} differs from scrip master ${sid}; using ${sid}`);
      }
      if (sid) this.remember(equityId(e.symbol), { segment: 'NSE_EQ', securityId: sid });
    }
  }

  private remember(id: string, ref: InstrumentRef) {
    this.learned.set(id, ref);
    this.reverse.set(`${ref.segment}:${ref.securityId}`, id);
  }

  // ---- Resolver ------------------------------------------------------------
  toDhan(id: string): InstrumentRef | null {
    const known = this.learned.get(id);
    if (known) return known;
    if (kindOf(id) === 'OPTION') {
      const sid = this.scrip?.options.get(id);
      if (sid) {
        const ref = { segment: 'NSE_FNO', securityId: sid };
        this.remember(id, ref);
        return ref;
      }
      return null;
    }
    const ext = parseExternalId(id);
    if (ext) return { segment: ext.segment, securityId: ext.securityId };
    return null;
  }

  fromDhan(rec: Parameters<Resolver['fromDhan']>[0]): string {
    const seg = rec.exchangeSegment ?? '';
    const sid = String(rec.securityId ?? '');
    const known = this.reverse.get(`${seg}:${sid}`);
    if (known) return known;
    if (seg === 'NSE_FNO') {
      const viaScrip = this.scrip?.optionsBySecurityId.get(sid);
      const id = viaScrip ?? niftyOptionIdFromDerivative(rec);
      if (id) {
        this.remember(id, { segment: seg, securityId: sid });
        return id;
      }
    }
    if (seg === 'NSE_EQ' && rec.tradingSymbol) {
      const eq = EQUITIES.find((e) => e.symbol === rec.tradingSymbol);
      if (eq) return equityId(eq.symbol);
    }
    const id = fallbackExternalId(rec);
    this.remember(id, { segment: seg || 'NSE_EQ', securityId: sid });
    return id;
  }

  // ---- Helpers ---------------------------------------------------------------
  private async cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
    const value = await fn();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  status(): StatusResponse {
    return {
      ok: !this.lastError,
      liveOrders: this.opts.liveOrders,
      clientId: this.dhan.clientId.replace(/.(?=.{3})/g, '•'),
      lotSize: this.scrip?.niftyLotSize ?? NIFTY_LOT_SIZE,
      scripMaster: !!this.scrip,
      error: this.lastError ?? undefined,
    };
  }

  // ---- Quotes (polled in the background, served from memory) ---------------
  getQuotes(ids: string[]): Quote[] {
    const now = Date.now();
    for (const id of ids) this.subscriptions.set(id, now);
    this.ensurePolling();
    return ids.map((id) => this.quotes.get(id)).filter((q): q is Quote => !!q);
  }

  /** Fetch immediately (used on first request so the client isn't left empty). */
  async primeQuotes(ids: string[]) {
    if (ids.every((id) => this.quotes.has(id))) return;
    await this.pollOnce();
  }

  private ensurePolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.pollOnce(), QUOTE_POLL_MS);
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async pollOnce() {
    if (this.polling) return;
    const now = Date.now();
    const wanted: { id: string; ref: InstrumentRef }[] = [];
    for (const [id, at] of this.subscriptions) {
      if (now - at > SUBSCRIPTION_TTL_MS) {
        this.subscriptions.delete(id);
        continue;
      }
      const ref = this.toDhan(id);
      if (ref) wanted.push({ id, ref });
    }
    if (!wanted.length) {
      this.stop();
      return;
    }
    const body: Record<string, number[]> = {};
    for (const { ref } of wanted) (body[ref.segment] ??= []).push(Number(ref.securityId));
    this.polling = true;
    try {
      const json = await this.dhan.quote(body);
      for (const q of mapQuotes(json, wanted)) this.quotes.set(q.id, q);
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
    } finally {
      this.polling = false;
    }
  }

  // ---- Charts ------------------------------------------------------------------
  intraday(id: string): Promise<number[]> {
    const ref = this.toDhan(id);
    if (!ref) throw new HttpError(404, `Unknown instrument ${id}`);
    const instrument = ref.segment === 'IDX_I' ? 'INDEX' : ref.segment === 'NSE_FNO' ? 'OPTIDX' : 'EQUITY';
    return this.cached(`intraday:${id}`, 60_000, async () => {
      const now = Date.now();
      const d = toIST(now);
      const pad = (n: number) => String(n).padStart(2, '0');
      const toDate = `${istDateString(now)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
      const fromDate = `${istDateString(now - 7 * 86400_000)} 09:15:00`;
      const json = await this.dhan.intraday({
        securityId: ref.securityId,
        exchangeSegment: ref.segment,
        instrument,
        fromDate,
        toDate,
      });
      return mapIntraday(json);
    });
  }

  // ---- Options -------------------------------------------------------------------
  expiries(): Promise<string[]> {
    return this.cached('expiries', 30 * 60_000, async () => {
      const today = istDateString(Date.now());
      return mapExpiries(await this.dhan.expiryList(Number(NIFTY_DHAN_ID), 'IDX_I')).filter((e) => e >= today);
    });
  }

  optionChain(expiry: string): Promise<OptionChainResponse> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw new HttpError(400, 'expiry must be YYYY-MM-DD');
    return this.cached(`chain:${expiry}`, 3000, async () => {
      const { spot, rows, securityIds } = mapOptionChain(
        await this.dhan.optionChain(Number(NIFTY_DHAN_ID), 'IDX_I', expiry),
        expiry,
      );
      for (const [id, sid] of securityIds) this.remember(id, { segment: 'NSE_FNO', securityId: sid });
      // Seed quotes so option prices are available immediately to position/order screens.
      // Subscribed ids are kept fresh by the quote poller instead.
      for (const r of rows) {
        for (const leg of [r.ce, r.pe]) {
          if (leg.ltp > 0 && !this.subscriptions.has(leg.id)) {
            this.quotes.set(leg.id, {
              id: leg.id,
              ltp: leg.ltp,
              open: leg.ltp,
              high: leg.ltp,
              low: leg.ltp,
              prevClose: leg.ltp,
            });
          }
        }
      }
      return { spot, rows };
    });
  }

  // ---- Account ---------------------------------------------------------------------
  async portfolio(): Promise<PortfolioResponse> {
    const [funds, positions, holdings] = await Promise.all([
      this.dhan.fundLimit(),
      this.dhan.positions().catch(emptyIfNoData),
      this.dhan.holdings().catch(emptyIfNoData),
    ]);
    const pos = mapPositions(positions, this);
    return { cash: mapFunds(funds), realizedPnl: pos.realized, rows: [...pos.rows, ...mapHoldings(holdings, this)] };
  }

  async orders(): Promise<OrdersResponse> {
    const list = await this.dhan.orders().catch(emptyIfNoData);
    const orders = (Array.isArray(list) ? list : []).map((o) => mapOrder(o, this));
    orders.sort((a, b) => b.createdAt - a.createdAt);
    return { orders };
  }

  async placeOrder(body: PlaceOrderBody): Promise<Order> {
    if (!this.opts.liveOrders) {
      throw new HttpError(403, 'Live orders are disabled on this server (start it with LIVE_ORDERS=true)');
    }
    const { instrumentId, side, qty, type, product } = body;
    if (side !== 'BUY' && side !== 'SELL') throw new HttpError(400, 'side must be BUY or SELL');
    if (type !== 'MARKET' && type !== 'LIMIT') throw new HttpError(400, 'type must be MARKET or LIMIT');
    if (product !== 'INTRADAY' && product !== 'DELIVERY')
      throw new HttpError(400, 'product must be INTRADAY or DELIVERY');
    if (!Number.isInteger(qty) || qty <= 0) throw new HttpError(400, 'qty must be a positive integer');
    if (kindOf(instrumentId) === 'INDEX') throw new HttpError(400, 'The index is not tradeable');
    const opt = parseOptionId(instrumentId);
    if (opt) {
      const lot = this.scrip?.niftyLotSize ?? NIFTY_LOT_SIZE;
      if (qty % lot !== 0) throw new HttpError(400, `Quantity must be a multiple of lot size ${lot}`);
    }
    let price = 0;
    if (type === 'LIMIT') {
      if (!(typeof body.limitPrice === 'number' && body.limitPrice > 0))
        throw new HttpError(400, 'Enter a valid limit price');
      price = roundToTick(body.limitPrice);
    }
    const ref = this.toDhan(instrumentId) ?? (opt ? await this.learnOption(instrumentId) : null);
    if (!ref) throw new HttpError(404, `No Dhan security id for ${instrumentId}`);

    if (this.opts.maxOrderValue > 0) {
      const ref_price = price || this.quotes.get(instrumentId)?.ltp || 0;
      if (ref_price * qty > this.opts.maxOrderValue) {
        throw new HttpError(400, `Order value exceeds the server limit of ₹${this.opts.maxOrderValue}`);
      }
    }

    const res = await this.dhan.placeOrder({
      securityId: ref.securityId,
      exchangeSegment: ref.segment,
      transactionType: side,
      quantity: qty,
      orderType: type,
      productType: dhanProductType(instrumentId, product),
      price,
    });
    const now = Date.now();
    // Try to fetch the full record; fall back to what placement returned.
    try {
      const full = await this.dhan.order(res.orderId);
      return mapOrder(Array.isArray(full) ? full[0] : full, this);
    } catch {
      return {
        id: String(res.orderId),
        instrumentId,
        side,
        qty,
        type,
        limitPrice: type === 'LIMIT' ? price : undefined,
        status: res.orderStatus === 'REJECTED' ? 'REJECTED' : 'OPEN',
        createdAt: now,
        updatedAt: now,
      };
    }
  }

  /** Option id not in the scrip master or seen yet: fetch its chain to learn the security id. */
  private async learnOption(id: string): Promise<InstrumentRef | null> {
    const opt = parseOptionId(id);
    if (!opt) return null;
    await this.optionChain(opt.expiry);
    return this.learned.get(id) ?? null;
  }

  async cancelOrder(orderId: string) {
    if (!this.opts.liveOrders) throw new HttpError(403, 'Live orders are disabled on this server');
    await this.dhan.cancelOrder(orderId);
  }
}

/** Dhan answers some empty lists with an error (e.g. no holdings). Treat those as empty. */
function emptyIfNoData(e: unknown): any[] {
  if (e instanceof DhanError && e.status !== 401 && e.code !== 'DH-901' && e.status < 500) return [];
  throw e;
}
