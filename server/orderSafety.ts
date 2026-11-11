/**
 * Order safety for live trading (audit fixes J-1, J-2, J-4), shared by v2 and the licensed v1.
 *
 *  - cancelConfirmed: cancel an order and find out from the broker what really happened to it —
 *    cancelled (and how much had filled first), filled, still working, or unknown. A cancel that
 *    errors or times out is never taken as "cancelled": the order is read back (several times).
 *  - heldQty: how much of an instrument the broker account actually holds (net, in the position's
 *    direction), from the broker's positions; null when it couldn't be read (never "0" on an error).
 *
 * No imports: the same file is copied into the v1 build.
 */

/** What the broker says about an order after a cancel attempt. */
export type CancelOutcome =
  /** No longer working. `filledQty` units executed before it stopped (0 = nothing). */
  | { state: 'CANCELLED'; status: string; filledQty: number; avgPrice: number }
  /** Fully executed (a stop-loss that fired). */
  | { state: 'FILLED'; status: string; filledQty: number; avgPrice: number }
  /** Still working at the broker (the cancel did not take). */
  | { state: 'ACTIVE'; status: string; filledQty: number; avgPrice: number }
  /** The order's status could not be read: nothing may be assumed. */
  | { state: 'UNKNOWN'; status: string; filledQty: number; avgPrice: number; error: string };

export interface OrderReader {
  /** The order in Dhan's shape (orderStatus, filledQty, averageTradedPrice, quantity); null if unknown. */
  order(id: string): Promise<any>;
  cancel(id: string): Promise<void>;
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const DEAD = new Set(['CANCELLED', 'REJECTED', 'EXPIRED']);

/** Classify one order read (null = unreadable). */
export function orderState(o: any): { state: 'CANCELLED' | 'FILLED' | 'ACTIVE' | null; status: string; filledQty: number; avgPrice: number } {
  if (!o) return { state: null, status: '', filledQty: 0, avgPrice: 0 };
  const status = String(o.orderStatus ?? '').toUpperCase();
  const avgPrice = num(o.averageTradedPrice) || num(o.price);
  // Only a TRADED order may fall back to its order quantity as the filled quantity.
  const filledQty = num(o.filledQty) || (status === 'TRADED' ? num(o.quantity) : 0);
  if (status === 'TRADED') return { state: 'FILLED', status, filledQty, avgPrice };
  if (DEAD.has(status)) return { state: 'CANCELLED', status, filledQty, avgPrice };
  return { state: status ? 'ACTIVE' : null, status, filledQty, avgPrice };
}

/**
 * Cancel `id` and confirm the result with the broker. Reads the order first (a stop that already
 * fired is reported FILLED and is not cancelled), sends the cancel, then reads it back up to
 * `tries` times `gapMs` apart until it is CANCELLED or FILLED.
 */
export async function cancelConfirmed(
  b: OrderReader,
  id: string,
  sleep: (ms: number) => Promise<void>,
  o: { tries?: number; gapMs?: number } = {},
): Promise<CancelOutcome> {
  const tries = o.tries ?? 4;
  const gapMs = o.gapMs ?? 500;
  type Read = ReturnType<typeof orderState>;
  let last: Read = { state: null, status: '', filledQty: 0, avgPrice: 0 };
  let error = '';
  const read = async (): Promise<Read> => {
    try {
      const r = orderState(await b.order(id));
      if (r.state == null) error = error || `order ${id} not found`;
      return r;
    } catch (e) {
      error = (e as Error).message;
      return { ...last, state: null };
    }
  };
  last = await read();
  if (last.state === 'FILLED' || last.state === 'CANCELLED') return { ...last, state: last.state };
  try {
    await b.cancel(id);
  } catch (e) {
    error = (e as Error).message; // e.g. "already traded", or no reply: the read-back decides
  }
  let seenActive = false;
  for (let i = 0; i < tries; i++) {
    last = await read();
    if (last.state === 'FILLED' || last.state === 'CANCELLED') return { ...last, state: last.state };
    if (last.state === 'ACTIVE') seenActive = true;
    if (i < tries - 1) await sleep(gapMs);
  }
  if (last.state === 'ACTIVE' || seenActive) return { ...last, state: 'ACTIVE' };
  return { state: 'UNKNOWN', status: last.status, filledQty: last.filledQty, avgPrice: last.avgPrice, error: error || 'status not readable' };
}

/** One broker position row, normalised (Dhan or Angel One). */
export interface PositionRow {
  securityId: string;
  /** Net quantity: + long, − short. */
  netQty: number;
  /** 'INTRADAY' | 'MARGIN' (Angel's CARRYFORWARD is MARGIN); '' when the broker didn't say. */
  product: string;
  /** Average sell / buy price of today's closing trades, when the broker gives it. */
  sellAvg?: number;
  buyAvg?: number;
}

/**
 * Quantity of `securityId` held in the position's direction (`side` +1 long / −1 short) for
 * `product`; 0 when flat (or held the other way); null when the positions couldn't be read.
 */
export async function heldQty(
  positions: () => Promise<PositionRow[]>,
  securityId: string,
  product: string,
  side: 1 | -1,
  sleep: (ms: number) => Promise<void>,
): Promise<{ qty: number; row: PositionRow | null } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const rows = (await positions()).filter(
        (r) => String(r.securityId) === String(securityId) && (!r.product || !product || r.product === product),
      );
      const net = rows.reduce((s, r) => s + num(r.netQty), 0);
      return { qty: Math.max(0, side * net), row: rows[0] ?? null };
    } catch {
      if (attempt === 0) await sleep(500);
    }
  }
  return null;
}
