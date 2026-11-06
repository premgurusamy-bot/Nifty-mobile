/// <reference types="node" />
/** Journal / log export: CSV escaping, columns, decision-log rows, full JSON bundle. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { csvField, eventsCsv, fullExportJson, journalCsv, journalStats, logCsv } from '../src/lib/export.ts';
import { EngineRunner } from '../src/lib/engine/runner.ts';
import type { Candle, ChainSnapshot, JournalRow } from '../src/lib/engine/types.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/workbook-2026-08-27.json', import.meta.url), 'utf8'));
const candles: Candle[] = fx.candles;
const chain: ChainSnapshot = fx.chain;

const row = (over: Partial<JournalRow>): JournalRow => ({
  id: 'J1', date: '2026-08-27', time: '11:40:27', spot: 24180, strike: 24200, direction: 'PE', entry: 82.65,
  sl: 70.1, target: 107.75, exit: 107.75, pnl: 1631.5, confidence: 88.9, trend: 'BEARISH', pcr: 0.92,
  oiBias: 'PE', iv: 12.3, delta: -0.45, entryReason: 'Auto-signal: SETUP PENDING, "break"', exitReason: 'TARGET 2', ...over,
});

test('csv fields are quoted only when needed', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('two\nlines'), '"two\nlines"');
  assert.equal(csvField(null), '');
  assert.equal(csvField(NaN), '');
  assert.equal(csvField(12.5), '12.5');
});

test('journal CSV: header, rows, result column, Excel-friendly', () => {
  const csv = journalCsv([row({}), row({ id: 'J2', exit: null, pnl: null }), row({ id: 'J3', pnl: -500 })]);
  assert.ok(csv.startsWith('﻿Date,Time,Symbol,Direction'));
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 4);
  assert.match(lines[1], /^2026-08-27,11:40:27,NIFTY,PE,24200,24180,82.65,70.1,107.75,107.75,1631.5,WIN,/);
  assert.match(lines[1], /"Auto-signal: SETUP PENDING, ""break"""/);
  assert.match(lines[2], /,OPEN,/);
  assert.match(lines[3], /,LOSS,/);
});

test('journal stats', () => {
  const s = journalStats([row({}), row({ id: 'J2', pnl: -500 }), row({ id: 'J3', pnl: null, exit: null })]);
  assert.deepEqual([s.trades, s.open, s.wins, s.losses, s.winRate, s.netPnl, s.best, s.worst], [2, 1, 1, 1, 50, 1131.5, 1631.5, -500]);
});

test('runner keeps a decision log (changes, new candles, errors) for export, not in the snapshot', async () => {
  let t = Date.UTC(2026, 7, 27, 6, 10, 27);
  let fail = false;
  const source = {
    load: async () => {
      if (fail) throw new Error('DH-905 network');
      return { candles, chain };
    },
    now: () => t,
  };
  const r = new EngineRunner(source as never, { load: async () => null, save: async () => {} });
  await r.init();
  await r.updateConfig({ confirmHoldMinutes: 0 }); // the workbook's immediate setup → pending sequence
  await r.refresh(); // SETUP ARMED → row
  t += 15_000;
  await r.refresh(); // SETUP PENDING (decision changed) → row
  t += 15_000;
  await r.refresh(); // same decision, same candle → no row
  fail = true;
  t += 15_000;
  await r.refresh(); // error → row
  const log = r.exportData().cycleLog;
  assert.deepEqual(log.map((x) => x.result), ['OK', 'OK', 'ERROR']);
  assert.match(log[0].decision, /^SETUP ARMED/);
  assert.match(log[1].decision, /^SETUP PENDING/);
  assert.match(log[0].factors, /=/);
  assert.ok(log[0].confidence! > 80);
  assert.match(log[2].status, /DH-905/);
  assert.equal('cycleLog' in r.snapshot().state, false);
  const csv = logCsv(log);
  assert.equal(csv.trim().split('\r\n').length, 4);
  assert.match(csv, /^﻿Time \(IST\),Symbol,Mode,Result/);
  assert.match(csv.split('\r\n')[1], /^2026-08-27 11:40:27,NIFTY,PAPER,OK,/);
  // journal reset keeps the log
  await r.resetJournal();
  assert.equal(r.exportData().cycleLog.length, 3);
  // full bundle
  const j = JSON.parse(fullExportJson(r.exportData(), { version: '1.0.0', demo: true }));
  assert.equal(j.cycleLog.length, 3);
  assert.equal(j.config.symbol, 'NIFTY');
  assert.ok(j.stats);
  assert.ok(!/accessToken|clientId/i.test(JSON.stringify(j)));
});

test('events CSV is oldest first', () => {
  const csv = eventsCsv([
    { at: 2000, kind: 'EXIT', message: 'b' },
    { at: 1000, kind: 'TRADE', message: 'a' },
  ]);
  const lines = csv.trim().split('\r\n');
  assert.match(lines[1], /,TRADE,a$/);
  assert.match(lines[2], /,EXIT,b$/);
});
