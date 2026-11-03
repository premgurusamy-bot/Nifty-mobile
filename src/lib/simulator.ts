import { EQUITIES, NIFTY_BASE, NIFTY_ID, equityId } from './instruments.ts';

/**
 * Simulated market feed. Produces correlated random-walk prices for the
 * NIFTY 50 index and a set of constituents. Replace with a real broker
 * feed by implementing the same `Quote` shape (see README → "Connecting a real broker").
 */

export interface Quote {
  id: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
}

export interface SimState {
  quotes: Record<string, Quote>;
  history: Record<string, number[]>;
  betas: Record<string, number>;
  seed: number;
}

export const HISTORY_LEN = 240;

/** Deterministic PRNG so tests and seeded history are reproducible. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller standard normal from a uniform source. */
function gauss(rand: () => number) {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const roundTick = (n: number) => Math.round(n * 20) / 20; // NSE equity tick 0.05

/** Per-tick volatility of the market factor (~1s ticks). */
const MARKET_VOL = 0.00035;
const IDIO_VOL = 0.0004;

export function createSim(seed = Date.now() % 2 ** 31): SimState {
  const rand = mulberry32(seed);
  const quotes: Record<string, Quote> = {};
  const history: Record<string, number[]> = {};
  const betas: Record<string, number> = { [NIFTY_ID]: 1 };

  const seedOne = (id: string, base: number) => {
    const prevClose = roundTick(base * (1 + (rand() - 0.5) * 0.02));
    const open = roundTick(prevClose * (1 + (rand() - 0.5) * 0.008));
    quotes[id] = { id, ltp: open, open, high: open, low: open, prevClose };
    history[id] = [open];
  };

  seedOne(NIFTY_ID, NIFTY_BASE);
  for (const e of EQUITIES) {
    seedOne(equityId(e.symbol), e.basePrice);
    betas[equityId(e.symbol)] = e.beta;
  }

  let state: SimState = { quotes, history, betas, seed };
  // Pre-fill intraday history so charts aren't empty on launch.
  for (let i = 0; i < HISTORY_LEN - 1; i++) state = stepSim(state, rand, 2);
  return state;
}

/**
 * Advance one tick. `scale` multiplies volatility (used to compress
 * history seeding). Returns a new state object (quotes are replaced).
 */
export function stepSim(state: SimState, rand: () => number, scale = 1): SimState {
  const market = gauss(rand) * MARKET_VOL * scale;
  const quotes: Record<string, Quote> = {};
  const history: Record<string, number[]> = {};

  for (const id of Object.keys(state.quotes)) {
    const q = state.quotes[id];
    const beta = state.betas[id] ?? 1;
    const idio = id === NIFTY_ID ? 0 : gauss(rand) * IDIO_VOL * scale;
    // Gentle mean reversion toward open keeps prices in a sane band over long sessions.
    const revert = ((q.open - q.ltp) / q.open) * 0.002;
    const next =
      id === NIFTY_ID ? round2(q.ltp * (1 + market + revert)) : roundTick(q.ltp * (1 + beta * market + idio + revert));
    quotes[id] = { ...q, ltp: next, high: Math.max(q.high, next), low: Math.min(q.low, next) };
    const h = state.history[id];
    const nh = h.length >= HISTORY_LEN ? h.slice(h.length - HISTORY_LEN + 1) : h.slice();
    nh.push(next);
    history[id] = nh;
  }
  return { ...state, quotes, history };
}

export const change = (q: Quote) => q.ltp - q.prevClose;
export const changePct = (q: Quote) => ((q.ltp - q.prevClose) / q.prevClose) * 100;
