/**
 * Export the trade journal and logs as CSV (opens in Excel / Google Sheets) or one
 * JSON bundle with everything, for reviewing and improving the strategy.
 */
import { summarizeJournal } from './engine/backtest.ts';
import type { EngineExport } from './engine/runner.ts';
import type { CycleLogRow, EngineEvent, JournalRow } from './engine/types.ts';

/** RFC 4180 field: quoted when it holds a comma, quote or line break. */
export function csvField(v: unknown): string {
  if (v == null) return '';
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  // CRLF + BOM so Excel opens it as UTF-8 (₹, ×, —) with proper rows.
  return '﻿' + [header, ...rows].map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}

const istStamp = (ms: number) => new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');

export function journalCsv(journal: JournalRow[]): string {
  return toCsv(
    [
      'Date', 'Time', 'Symbol', 'Direction', 'Strike', 'Spot', 'Entry', 'SL', 'Target', 'Exit', 'P&L',
      'Result', 'Confidence', 'Trend', 'PCR', 'OI bias', 'IV', 'Delta', 'Entry reason', 'Exit reason', 'Id',
    ],
    journal.map((j) => [
      j.date, j.time, j.symbol ?? 'NIFTY', j.direction, j.strike || '', j.spot, j.entry, j.sl, j.target, j.exit,
      j.pnl, j.pnl == null ? 'OPEN' : j.pnl > 0 ? 'WIN' : j.pnl < 0 ? 'LOSS' : 'FLAT',
      j.confidence, j.trend, j.pcr, j.oiBias, j.iv, j.delta, j.entryReason, j.exitReason, j.id,
    ]),
  );
}

export function logCsv(log: CycleLogRow[]): string {
  return toCsv(
    [
      'Time (IST)', 'Symbol', 'Mode', 'Result', 'Spot', 'Trend', 'Signal', 'Direction', 'Strike', 'Confidence',
      'Score CE/LONG', 'Score PE/SHORT', 'Pattern', 'PCR', 'IV percentile', 'Factors', 'Decision', 'Position',
      'Realized today', 'Status',
    ],
    log.map((r) => [
      istStamp(r.at), r.symbol, r.mode, r.result, r.spot, r.trend, r.signal, r.direction, r.strike || '',
      r.confidence, r.scoreUp, r.scoreDown, r.pattern, r.pcr, r.ivPercentile, r.factors, r.decision, r.position,
      r.realizedToday, r.status,
    ]),
  );
}

export function eventsCsv(events: EngineEvent[]): string {
  return toCsv(
    ['Time (IST)', 'Kind', 'Message'],
    [...events].reverse().map((e) => [istStamp(e.at), e.kind, e.message]),
  );
}

/** Win rate, P&L, best / worst trade, per-day results. */
export function journalStats(journal: JournalRow[]) {
  const closed = journal.filter((j) => j.pnl != null);
  const pnls = closed.map((j) => j.pnl!);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  return {
    trades: closed.length,
    open: journal.length - closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? Math.round((wins.length / closed.length) * 1000) / 10 : 0,
    netPnl: Math.round(sum(pnls) * 100) / 100,
    avgWin: wins.length ? Math.round((sum(wins) / wins.length) * 100) / 100 : 0,
    avgLoss: losses.length ? Math.round((sum(losses) / losses.length) * 100) / 100 : 0,
    best: pnls.length ? Math.max(...pnls) : 0,
    worst: pnls.length ? Math.min(...pnls) : 0,
    days: summarizeJournal(journal),
  };
}

/** Everything in one file (settings contain no Dhan credentials — those stay in secure storage). */
export function fullExportJson(data: EngineExport, app: { version: string; demo: boolean }): string {
  return JSON.stringify(
    {
      app: 'Nifty Trader',
      appVersion: app.version,
      demo: app.demo,
      exportedAtIst: istStamp(data.exportedAt),
      stats: journalStats(data.journal),
      ...data,
    },
    null,
    2,
  );
}

export const exportFileName = (kind: string, at: number, symbol: string) =>
  `nifty-trader-${kind}-${symbol.toLowerCase()}-${istStamp(at).replace(/[: ]/g, '-')}`;
