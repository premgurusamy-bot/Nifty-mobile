/**
 * Order gateways: the same small interface for Dhan and Angel One, so live trading can send each
 * index's orders to its own broker and switch to the other one when an entry can't go through.
 * Order details come back in Dhan's shape (orderStatus TRADED / PENDING / CANCELLED / REJECTED …,
 * averageTradedPrice, filledQty, quantity, price, omsErrorDescription) whichever broker it is.
 */
import { optionId } from '../src/lib/instruments.ts';
import type { EngineConfig, TradePlan } from '../src/lib/engine/types.ts';
import { AngelError, type AngelClient } from './angel.ts';
import type { AngelEngineSource } from './angelSource.ts';
import { DhanError, type DhanClient } from './dhan.ts';
import { underlyingFor, type DhanService } from './service.ts';

export type BrokerName = 'DHAN' | 'ANGEL';

export interface Instrument {
  securityId: string;
  /** Angel One needs the trading symbol with the token. */
  tradingSymbol?: string;
}

export interface PlaceArgs {
  inst: Instrument;
  segment: string;
  side: 'BUY' | 'SELL';
  qty: number;
  type: 'MARKET' | 'LIMIT' | 'STOP_LOSS';
  price: number;
  trigger?: number;
  product: 'INTRADAY' | 'MARGIN';
}

export interface OrderGateway {
  readonly name: BrokerName;
  /** Logged in / has a token. */
  ready(): boolean;
  instrument(cfg: EngineConfig, plan: Pick<TradePlan, 'direction' | 'strike'>, expiry: string): Promise<Instrument>;
  place(o: PlaceArgs): Promise<string>;
  /** The order in Dhan's shape (null if the broker doesn't know it). */
  order(id: string): Promise<any>;
  cancel(id: string): Promise<void>;
  /**
   * After an unclear failure (no reply): did an order like this reach the broker anyway?
   * Returns its id, null when certainly not, undefined when it couldn't be checked.
   */
  findRecent(o: PlaceArgs, sinceMs: number): Promise<string | null | undefined>;
}

/** The request never got a reply: it may or may not have been placed. */
export const isUnclear = (e: unknown) => /^Cannot reach/i.test((e as Error)?.message ?? '');
/** The broker answered with an error: nothing was placed. */
export const isRefused = (e: unknown) => (e instanceof DhanError || e instanceof AngelError) && !isUnclear(e);

const upper = (s: unknown) => String(s ?? '').toUpperCase();

export class DhanGateway implements OrderGateway {
  readonly name = 'DHAN' as const;
  private dhan: DhanClient;
  private service: DhanService;
  constructor(dhan: DhanClient, service: DhanService) {
    this.dhan = dhan;
    this.service = service;
  }
  ready() {
    return true;
  }
  async instrument(cfg: EngineConfig, plan: Pick<TradePlan, 'direction' | 'strike'>, expiry: string): Promise<Instrument> {
    if (cfg.instrumentKind === 'MCX_FUTURES') {
      if (!cfg.futSecurityId) throw new DhanError(`No ${cfg.symbol} contract resolved yet — tap Refresh now first`, 400);
      return { securityId: cfg.futSecurityId };
    }
    if (plan.direction !== 'CE' && plan.direction !== 'PE') throw new DhanError('Option plan expected', 400);
    const id = optionId({ underlying: cfg.symbol, expiry, strike: plan.strike, type: plan.direction });
    let ref = this.service.toDhan(id);
    if (!ref) {
      await this.service.optionChain(expiry, underlyingFor(cfg.symbol)); // learns security ids from Dhan's chain
      ref = this.service.toDhan(id);
    }
    if (!ref) throw new DhanError(`No Dhan security id for ${cfg.symbol} ${expiry} ${plan.strike} ${plan.direction}`, 404);
    return { securityId: ref.securityId };
  }
  async place(o: PlaceArgs) {
    const res = await this.dhan.placeOrder({
      securityId: o.inst.securityId,
      exchangeSegment: o.segment,
      transactionType: o.side,
      quantity: o.qty,
      orderType: o.type,
      productType: o.product,
      price: o.price,
      ...(o.trigger != null ? { triggerPrice: o.trigger } : {}),
    });
    return String(res.orderId);
  }
  async order(id: string) {
    const o = await this.dhan.order(id);
    return Array.isArray(o) ? o[0] : o;
  }
  async cancel(id: string) {
    await this.dhan.cancelOrder(id);
  }
  async findRecent(o: PlaceArgs, sinceMs: number) {
    try {
      const list = (await this.dhan.orders()) ?? [];
      const hit = list.find(
        (x: any) =>
          String(x.securityId) === o.inst.securityId &&
          upper(x.transactionType) === o.side &&
          Number(x.quantity) === o.qty &&
          // createTime is IST 'YYYY-MM-DD HH:mm:ss'; without one, any match today counts.
          (!x.createTime || Date.parse(String(x.createTime).replace(' ', 'T') + '+05:30') >= sinceMs - 60_000),
      );
      return hit ? String(hit.orderId) : null;
    } catch {
      return undefined;
    }
  }
}

const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
/** Angel's '08-Nov-2026 10:15:20' (IST) → ms, or null. */
export function angelTime(s: unknown): number | null {
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const mo = MON.indexOf(m[2].toUpperCase());
  if (mo < 0) return null;
  return Date.UTC(+m[3], mo, +m[1], +m[4], +m[5], +m[6]) - 5.5 * 3600_000;
}

/** Angel One status → Dhan's status words. */
export function angelStatus(o: any): string {
  const st = String(o?.status ?? o?.orderstatus ?? '').toLowerCase();
  const filled = Number(o?.filledshares ?? 0);
  if (st === 'complete') return 'TRADED';
  if (st === 'rejected') return 'REJECTED';
  if (st === 'cancelled') return 'CANCELLED';
  if (st === 'trigger pending') return 'TRIGGER_PENDING';
  return filled > 0 ? 'PART_TRADED' : 'PENDING';
}

export class AngelGateway implements OrderGateway {
  readonly name = 'ANGEL' as const;
  private angel: AngelClient;
  private source: AngelEngineSource;
  private book: { at: number; list: any[] } | null = null;
  constructor(angel: AngelClient, source: AngelEngineSource) {
    this.angel = angel;
    this.source = source;
  }
  ready() {
    return this.angel.connected;
  }
  async instrument(cfg: EngineConfig, plan: Pick<TradePlan, 'direction' | 'strike'>, expiry: string): Promise<Instrument> {
    if (cfg.instrumentKind !== 'INDEX_OPTIONS' || (plan.direction !== 'CE' && plan.direction !== 'PE'))
      throw new AngelError(`Angel One orders are set up for index options only (${cfg.symbol})`, 'UNSUPPORTED');
    const c = await this.source.contractFor(cfg.symbol, expiry, plan.strike, plan.direction);
    return { securityId: c.token, tradingSymbol: c.tradingsymbol };
  }
  async place(o: PlaceArgs) {
    if (!o.inst.tradingSymbol) throw new AngelError('Angel One order: trading symbol missing', 'NO_SYMBOL');
    this.book = null;
    return this.angel.placeOrder({
      variety: o.type === 'STOP_LOSS' ? 'STOPLOSS' : 'NORMAL',
      tradingsymbol: o.inst.tradingSymbol,
      symboltoken: o.inst.securityId,
      transactiontype: o.side,
      exchange: 'NFO',
      ordertype: o.type === 'STOP_LOSS' ? 'STOPLOSS_LIMIT' : o.type,
      producttype: o.product === 'MARGIN' ? 'CARRYFORWARD' : 'INTRADAY',
      price: o.type === 'MARKET' ? 0 : o.price,
      triggerprice: o.trigger,
      quantity: o.qty,
    });
  }
  private async raw(id: string): Promise<any> {
    // One order-book read serves every lookup within a second.
    if (!this.book || Date.now() - this.book.at > 900) this.book = { at: Date.now(), list: await this.angel.orderBook() };
    return this.book.list.find((x) => String(x.orderid) === id) ?? null;
  }
  async order(id: string) {
    // The order book is read at most about once a second (cached 0.9 s; cleared after a place / cancel).
    const o = await this.raw(id);
    if (!o) return null;
    return {
      orderId: id,
      orderStatus: angelStatus(o),
      averageTradedPrice: Number(o.averageprice ?? 0),
      filledQty: Number(o.filledshares ?? 0),
      quantity: Number(o.quantity ?? 0),
      price: Number(o.price ?? 0),
      omsErrorDescription: o.text || '',
      variety: o.variety,
    };
  }
  async cancel(id: string) {
    const o = await this.raw(id).catch(() => null);
    this.book = null;
    await this.angel.cancelOrder(id, o?.variety || 'NORMAL');
  }
  async findRecent(o: PlaceArgs, sinceMs: number) {
    try {
      this.book = null;
      const list = await this.angel.orderBook();
      const hit = list.find((x) => {
        if (String(x.symboltoken) !== o.inst.securityId || upper(x.transactiontype) !== o.side || Number(x.quantity) !== o.qty)
          return false;
        const t = angelTime(x.updatetime ?? x.exchtime);
        return t == null || t >= sinceMs - 60_000;
      });
      return hit ? String(hit.orderid) : null;
    } catch {
      return undefined;
    }
  }
}
