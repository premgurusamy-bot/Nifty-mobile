/**
 * Strategy results for the Portfolio tab, from the engine's trade journal:
 * P&L, win rate, profit factor, drawdown, equity on the configured capital,
 * and an estimate of exchange charges (paper fills include none).
 */
import type { JournalRow, TradeMode } from './engine/types.ts';

/** PAPER or LIVE for a journal row (older rows: read from the entry reason). */
export const rowMode = (j: JournalRow): TradeMode => j.mode ?? (/LIVE entry/.test(j.entryReason) ? 'LIVE' : 'PAPER');

/**
 * Estimated charges for one NSE option round trip (₹), at the rates last known
 * (verify against Dhan's current schedule): brokerage ₹20 per order, STT 0.1% of the
 * sell value, exchange 0.03503% and SEBI ₹10/crore of both sides, stamp 0.003% of the
 * buy value, GST 18% on brokerage + exchange + SEBI.
 */
export function optionCharges(entry: number, exit: number, qty: number): number {
  const buy = entry * qty;
  const sell = exit * qty;
  const brokerage = 40;
  const exchange = (buy + sell) * 0.0003503;
  const sebi = (buy + sell) * 0.000001;
  return brokerage + sell * 0.001 + exchange + sebi + buy * 0.00003 + 0.18 * (brokerage + exchange + sebi);
}

export interface StrategyResults {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  net: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  best: number | null;
  worst: number | null;
  /** Largest fall of cumulative closed-trade P&L from a previous high (₹, ≤ 0). */
  maxDrawdown: number;
  /** Estimated charges on closed option trades with a known quantity (null when none). */
  estCharges: number | null;
  /** Trades whose charges couldn't be estimated (older rows without quantity, MCX). */
  chargesUnknown: number;
  today: number;
  /** Closed trades, newest first. */
  recent: JournalRow[];
}

export function strategyResults(journal: JournalRow[], mode: TradeMode, todayIst: string): StrategyResults {
  const rows = journal.filter((j) => rowMode(j) === mode);
  const closed = rows.filter((j) => j.pnl != null);
  const pnls = closed.map((j) => j.pnl!);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  let peak = 0;
  let cum = 0;
  let maxDrawdown = 0;
  for (const p of pnls) {
    cum += p;
    peak = Math.max(peak, cum);
    maxDrawdown = Math.min(maxDrawdown, cum - peak);
  }
  let estCharges: number | null = null;
  let chargesUnknown = 0;
  for (const j of closed) {
    const isFut = j.direction === 'LONG' || j.direction === 'SHORT';
    if (!j.qty || j.exit == null || isFut) {
      chargesUnknown++;
      continue;
    }
    estCharges = (estCharges ?? 0) + optionCharges(j.entry, j.exit, j.qty);
  }
  const grossProfit = sum(wins);
  const grossLoss = sum(losses);
  return {
    trades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : null,
    net: sum(pnls),
    grossProfit,
    grossLoss,
    profitFactor: grossLoss < 0 ? grossProfit / -grossLoss : null,
    avgWin: wins.length ? grossProfit / wins.length : null,
    avgLoss: losses.length ? grossLoss / losses.length : null,
    best: pnls.length ? Math.max(...pnls) : null,
    worst: pnls.length ? Math.min(...pnls) : null,
    maxDrawdown,
    estCharges,
    chargesUnknown,
    today: sum(closed.filter((j) => j.date === todayIst).map((j) => j.pnl!)),
    recent: [...closed].reverse(),
  };
}
