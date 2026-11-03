#!/usr/bin/env python3
"""
Import your NIFTY_Option_System workbook into the server's engine state.

Copies the trade journal (07_TradeJournal), IV history (12_IVHistory), the
open position + daily counters (05_DecisionEngine) and your thresholds /
index settings (05_DecisionEngine, 09_Settings) into server/data/engine.json.

It never reads the Dhan Client ID / Access Token cells — put those in the
server's .env instead.

    pip install openpyxl
    python3 scripts/import_workbook.py NIFTY_Option_System_v4_fixed.xlsm [server/data/engine.json]

Stop the server before importing (it rewrites the file on every refresh).
"""
import datetime as dt
import json
import os
import sys

import openpyxl

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))


def num(v, default=0.0):
    try:
        return float(v) if v not in (None, '') else default
    except (TypeError, ValueError):
        return default


def as_date(v):
    if isinstance(v, (dt.datetime, dt.date)):
        return v.strftime('%Y-%m-%d')
    return str(v or '')[:10]


def as_time(v):
    if isinstance(v, (dt.time, dt.datetime)):
        return v.strftime('%H:%M:%S')
    return str(v or '')


def epoch_ms_ist(v):
    """Workbook timestamps are IST wall-clock values (VBA Now)."""
    if not isinstance(v, dt.datetime):
        return 0
    return int(v.replace(tzinfo=IST).timestamp() * 1000)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    keep_position = '--keep-position' in sys.argv
    src = args[0]
    out = args[1] if len(args) > 1 else os.path.join('server', 'data', 'engine.json')
    wb = openpyxl.load_workbook(src, data_only=True, read_only=True)
    dec = wb['05_DecisionEngine']
    st = wb['09_Settings']
    c = lambda ws, ref: ws[ref].value

    config = {
        'symbol': str(c(st, 'C7') or 'NIFTY').upper(),
        'underlyingSecurityId': int(num(c(st, 'C8'), 13)),
        'underlyingSegment': str(c(st, 'C9') or 'IDX_I'),
        'expiry': as_date(c(st, 'C10')) if c(st, 'C10') else '',
        'refreshSeconds': max(15, int(num(c(st, 'C11'), 15))),
        'autoRefresh': str(c(st, 'C13')).upper() == 'TRUE',
        'alertsEnabled': str(c(st, 'C15')).upper() != 'FALSE',
        'strikeInterval': num(c(st, 'C25'), 50) or 50,
        'confHigh': num(c(dec, 'C5'), 80),
        'confWatch': num(c(dec, 'C6'), 65),
        'rrTarget': num(c(dec, 'C7'), 2),
        'maxRisk': num(c(dec, 'C8'), 2000),
        'lotSize': int(num(c(dec, 'C9'), 65)),
        'atrMult': num(c(dec, 'C10'), 1.5),
        'maxTradesPerDay': int(num(c(dec, 'C17'), 2)),
        'maxDailyLoss': num(c(dec, 'C41'), 0),
    }

    journal = []
    row_to_id = {}
    for i, r in enumerate(wb['07_TradeJournal'].iter_rows(min_row=2, values_only=True), start=2):
        if r[0] is None:
            continue
        jid = f'J{len(journal) + 1}'
        row_to_id[i] = jid
        pnl = r[9] if isinstance(r[9], (int, float)) else None
        journal.append({
            'id': jid, 'date': as_date(r[0]), 'time': as_time(r[1]), 'spot': num(r[2]), 'strike': num(r[3]),
            'direction': str(r[4] or 'CE'), 'entry': num(r[5]), 'sl': num(r[6]), 'target': num(r[7]),
            'exit': r[8] if isinstance(r[8], (int, float)) else None, 'pnl': pnl,
            'confidence': num(r[10]), 'trend': str(r[11] or ''), 'pcr': num(r[12]), 'oiBias': str(r[13] or ''),
            'iv': num(r[14]), 'delta': num(r[15]), 'entryReason': str(r[16] or ''), 'exitReason': str(r[17] or ''),
        })

    iv = [num(r[5]) for r in wb['12_IVHistory'].iter_rows(min_row=2, values_only=True) if r and num(r[5]) > 0]

    position = None
    if str(c(dec, 'C26')).upper() == 'TRUE':
        position = {
            'direction': str(c(dec, 'C27')), 'strike': num(c(dec, 'C28')), 'entry': num(c(dec, 'C29')),
            'originalSl': num(c(dec, 'C30')), 'target1': num(c(dec, 'C31')), 'target2': num(c(dec, 'C32')),
            'totalQty': num(c(dec, 'C33')), 'journalId': row_to_id.get(int(num(c(dec, 'C34'))), ''),
            'openedAt': epoch_ms_ist(c(dec, 'C35')),
            'partialBooked': str(c(dec, 'C36')).upper() == 'TRUE', 'partialQty': num(c(dec, 'C37')),
            'partialPnl': num(c(dec, 'C38')), 'remainingQty': num(c(dec, 'C39')), 'currentSl': num(c(dec, 'C40')),
        }

    today = dt.datetime.now(IST).strftime('%Y-%m-%d')
    if position and not keep_position:
        opened = dt.datetime.fromtimestamp(position['openedAt'] / 1000, IST).strftime('%Y-%m-%d') if position['openedAt'] else ''
        if opened != today:
            print(f'WARNING: dropping the open {position["direction"]} {position["strike"]:.0f} position opened {opened or "on an unknown day"}: '
                  'its weekly contract has likely expired, and the engine would otherwise "monitor" it against a '
                  'different expiry. Its journal row stays (exit blank). Use --keep-position to import it anyway.')
            position = None

    pending = None
    if c(dec, 'C19'):
        pending = {'direction': str(c(dec, 'C19')), 'trigger': num(c(dec, 'C20')), 'strike': num(c(dec, 'C21')),
                   'setAt': epoch_ms_ist(c(dec, 'C22'))}

    state = {
        'day': as_date(c(dec, 'C15')), 'tradesToday': int(num(c(dec, 'C16'))), 'blockedReason': str(c(dec, 'C18') or ''),
        'pending': pending, 'lastFiredKey': str(c(dec, 'C23') or ''), 'realizedToday': num(c(dec, 'C42')),
        'position': position, 'journal': journal, 'ivHistory': iv, 'events': [], 'seq': len(journal),
        'lastDecisionText': '',
    }

    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    with open(out, 'w') as f:
        json.dump({'state': state, 'config': config}, f)
    print(f'Wrote {out}: {len(journal)} journal rows, {len(iv)} IV snapshots, '
          f'open position: {"yes" if position else "no"}, config: {config["symbol"]} lot {config["lotSize"]}')


if __name__ == '__main__':
    main()
