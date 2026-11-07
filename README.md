# Nifty Trader (mobile)

Your **NIFTY Option Buying System** (the `NIFTY_Option_System_v4` Excel/VBA workbook) as a mobile app, on the **Dhan HQ API v2**.

The workbook's decision engine was ported rule for rule to TypeScript. A golden test checks it against the workbook's own last refresh (27-Aug-2026 11:40 IST): fed the same candles, option chain and IV history, the app reproduces Excel's EMA20/EMA50/VWAP/ATR on all 225 candles. It also matches PCR, Max Pain, OI support/resistance, swing levels, the **88.898 confidence score with all 10 factor scores**, the Greeks and the IV snapshot.

> Decision-support tool, like the workbook. The engine only **signals** and paper-tracks its position; it never places orders by itself. Confidence and R:R are a filter, not a prediction.

## Versions

**v1.0** (tag `v1.0`, 7 Nov 2026) — the first version marked as working, frozen as-is:
NIFTY / BANK NIFTY / FIN NIFTY options and MCX mini futures on Dhan (phone only, no server); login with
client ID + PIN (TOTP made by the app) and logout; PAPER / LIVE with pre-flight check and static IP;
Manual / Automatic entries; 3-minute hold before entry; entry cutoff 14:35; cheap-premium filters; sizing
by risk, capital % or fixed lots (own stop %); Day plan lock and profit lock; live P&L; Screener for indexes
and MCX; calibrated scoring (NIFTY unchanged); alerts with sound, background running; journal / decision
log export; Portfolio strategy results.

- Code: `git checkout v1.0`
- APK: https://github.com/premgurusamy-bot/Nifty-mobile/releases/download/v1.0/nifty-trader.apk
- New work continues on the development branch; the "latest" link keeps pointing at the newest build.

## What's in the app

| Tab | Workbook equivalent |
| --- | --- |
| **Dashboard** | `01_Dashboard` + `04_Analytics`. Signal (BUY CE / BUY PE / WAIT / NO TRADE / IN POSITION), decision text, confidence meter, trade plan or open position (trailing SL, T1/T2, partial booking), market, option-chain metrics, Greeks, 10-factor score breakdown, daily discipline, alerts. *Refresh now* and *Auto refresh* work like the workbook's buttons. |
| **Option Chain** | `03_OptionChain`. Live Dhan chain (LTP, delta, IV, OI), 3 expiries, tap a premium to open the order ticket. |
| **Journal** | `07_TradeJournal`, `11_Summary` (daily table + equity curve) and `08_Backtest`. |
| **Markets** | Live NIFTY 50 index + watchlist with intraday charts. |
| **Portfolio / Orders** | Dhan funds, positions, holdings and order book (live), or a paper account on live prices. |
| **Settings** (⚙) | `09_Settings` + `05_DecisionEngine` thresholds, NIFTY/BANKNIFTY/FINNIFTY presets, server connection. |

### The engine (ported modules)

`src/lib/engine/` is pure TypeScript with no React or network code, so the same engine runs on the server and on the phone.

| File | VBA module(s) |
| --- | --- |
| `indicators.ts` | `modAnalytics`: EMA20/50, session-reset VWAP, Wilder ATR14 (gap-free at day open), PCR, Max Pain, OI support/resistance, ATM |
| `priceAction.ts` | `modPriceAction` v4: engulfing, pin bars, doji, inside bar, EMA/VWAP pullbacks, OI and swing level reactions, volume confirmation, confluence bonus, 0–10 rescale, swing levels |
| `decision.ts` | `modDecisionEngine`, `modSignalState`, `modPosition`, `modIVHistory`, `modTradeJournal`: best strike (ATM + 2 OTM), 10-factor score, the **armed → pending → confirmed-break** state machine, the daily trade limit, no-revenge rule, ₹ daily max loss, trade plan (ATR × mult × delta risk, lots sized to max risk), half booking at T1 with the stop trailed to breakeven, T2/SL exits, IV percentile after 20 snapshots |
| `backtest.ts` | `modBacktest`, `modSummary` |
| `runner.ts` | `modMain.RefreshAll` / auto-refresh loop (market-hours gated, 3 s minimum) |

**Deliberate differences from the VBA** (bug fixes):

- Best-strike stepping uses the configured strike interval. The VBA hard-coded 50, which is wrong for BANKNIFTY.
- The no-revenge-trade check compares journal dates reliably. The VBA compared a date cell with a text string.
- R:R shows as `1:2.0`. Excel had auto-converted `1:2` into a time (`0:01:02`).

**Kept as in the workbook (so you know):**

- SL and target exits are booked at the SL/target *level*, not at the (possibly gapped) live premium.
- Journal entry reasons record the previous cycle's setup text (e.g. "SETUP PENDING - waiting for break of …").

**Not ported yet:** the V5 multi-instrument screener (`modV5Screener`, `modMarketRegime`, `14_V5Config`) and the NSE-website fallback (`modNSEDirect`).

## Architecture

```
 Phone app (Expo)  ──HTTPS + access key──▶  Bridge server (server/, Node)  ──▶  Dhan HQ API v2
  dashboard, journal,                       • runs the engine every 3–15 s in market hours
  chain, orders                             • holds your Dhan token (never on the phone)
                                            • journal / IV history in server/data/engine.json
                                            • respects Dhan rate limits, Telegram alerts
```

The engine runs on the **server**, as Excel's `OnTime` loop did, so stop losses and targets are tracked even while your phone is locked. Without a server, the app runs the same engine in **demo mode** on an accelerated NIFTY simulation (each refresh = one 5-minute candle).

## Instruments

Pick the instrument in ⚙ Settings → **Instrument**. All of its settings load together: Dhan ids/segments, lot size, tick, ₹ per point, strike step, market hours, and its own IV history. Switching is blocked while a trade or entry order is open.

| Group | Instruments | How it trades |
| --- | --- | --- |
| Index options | NIFTY 50, BANK NIFTY, FIN NIFTY | The Excel option-buying system: buy CE/PE on the best strike near ATM. Quantity is in units (lots of 65 / 30 / 60, verify against NSE). Capped at 10 lots by default. |
| MCX mini futures | Gold Mini, Silver Mini, Crude Oil Mini, Natural Gas Mini, Lead Mini, Zinc Mini, Aluminium Mini | Long or short the current-month future. Quantity is in **lots** (Dhan's MCX convention). P&L uses ₹ per 1.00 move per lot (e.g. Gold Mini ₹10, Lead Mini ₹1,000; verify against MCX). Capped at 1 lot by default. |

**MCX details**

- **Current contract:** looked up in Dhan's instrument list (`/v2/instrument/MCX_COMM`, with the compact scrip master as fallback). It rolls to the next month `rollDays` (default 3) before expiry. If lookup fails, enter the contract's security id by hand.
- **Market hours:** 09:00–23:30 IST, or 23:55 while the US is on standard time.
- **Futures score (100 points):** not from the workbook, because futures have no option chain. It keeps the workbook's EMA-trend, VWAP and price-action rules, and adds:
  - momentum (EMA spread / ATR)
  - volume confirmation
  - position vs the day open
  - breakout / room to the next level
  - **OI buildup**: long buildup and short covering favour longs; short buildup and long unwinding favour shorts
  - volatility fit

  The same arm → confirm → trade flow, daily limits, T1 half-booking and breakeven trail apply. Shorts have their stop above the entry.
- **Live orders:** a short opens with a SELL and is protected by a BUY STOP_LOSS above it. All prices are on the instrument's tick.
- **Paper-test first:** the futures model is new, so trade it on PAPER before using real money.

## Position size & capital

Settings → **Position size & capital** chooses how many lots a trade takes:

- **Risk per trade** (the workbook, default): lots = max risk ÷ (stop distance × ₹ per point per lot).
- **Fixed lots**: every trade takes the lots you set. For options the stop-loss is your chosen % below the
  entry premium (1–40%, on the ₹0.05 tick; targets 2× and 3× that distance) instead of the ATR stop; the
  "maximum stop %" premium filter is off in this mode, the minimum premium still applies. MCX keeps its ATR
  stop. Max lots still caps it, and a trade is blocked if the capital can't pay for the lots (LIVE with the
  balance not fetched yet is left to Dhan).
- **Capital %**: lots = capital × % ÷ cost of one lot. Options cost premium × lot size; MCX futures cost the
  margin per lot (enter it, or leave 0 to estimate 12 % of price × point value).
  - PAPER uses the **paper capital**; LIVE uses the **live capital**, or the Dhan available balance
    (fetched each refresh) when live capital is 0. Use 100 % to put the whole capital into a trade.
  - **Max lots per trade** still caps the size (set 0 for no cap). If the capital can't buy one lot the
    signal is blocked and ENTER is disabled, with the reason shown.

## Alerts (on the phone)

Settings → **Alerts** shows an on-screen message, plays a sound and vibrates for: confirmed LIVE signals
(once each), entries (including limit fills), Target 1, stop-loss hits, other exits and live order errors.
Each event type can be switched off. Volume Low / Medium / High (30 / 60 / 100 % of the media volume);
built-in Chime / Beep / Bell / Alarm, or **Pick custom sound** to use any audio file on the phone (copied
into the app). Alerts work while the app is open.

### Run in background (Android)

Settings → **Run in background** starts a foreground service (a permanent "Nifty Trader is watching the
market" notification showing instrument, mode, signal and last refresh). It keeps the engine refreshing,
live orders followed up and alerts sounding while you use other apps or the screen is off; alerts then pop up
as high-priority notifications over any app and on the lock screen, with the chosen sound and volume.
Turning it on also turns auto-refresh on. Leave the app with Home / the app switcher — swiping it away
closes it, and the service then posts a "stopped watching" alert and stops. Use **Allow unrestricted
battery use**, and on Xiaomi / Oppo / Vivo / Realme / OnePlus also allow Autostart.

## Hold before entry

Reaching the trade level (80) no longer enters on the next break by itself. Settings → Engine settings →
**Hold before entry** (default **3 minutes**, 0 = the workbook's immediate rule): the score must stay at or
above the trade level for that long (a dip below restarts the wait), and — with **enter only if the score held
or rose** on (default) — end at or above where the hold started (0.5-point tolerance; otherwise "SETUP
FADING" and the hold starts again). Then price must break the setup's trigger. The Dashboard shows
`SETUP HOLDING - score rising / steady / falling since 82.4, entry check at 11:43:00`. Applies to PAPER
automatic entries, LIVE automatic entries and the confirmed-signal alerts; a manual ENTER is not held back.

## Score calibration (BANK NIFTY, FIN NIFTY, MCX)

The confidence engine was tuned on NIFTY; NIFTY's scoring is unchanged (the golden workbook tests still
pass exactly). For every other instrument, the few thresholds that are absolute numbers are rescaled
(`src/lib/engine/calibration.ts`): gamma band ÷ and theta limits × the price level vs NIFTY (24,200),
"clearly past VWAP" (0.05%) and, for MCX, "up from the day open" (0.2%) × the instrument's 5-minute ATR %
vs NIFTY's (0.055%, bounded 0.5–4×), and strike-liquidity units × lot size vs NIFTY's 65. Everything else
(EMA trend, PCR, delta, IV percentile per instrument, price action, momentum, breakout) is already
scale-free. Check: the real 27 Aug NIFTY market scaled to BANK NIFTY's price level scored 82.9 before
(gamma 4 instead of 10) and 88.9 — the same as NIFTY — after. The Dashboard shows the factors used.

## Screener (index / MCX picker + "market today")

The **Screener** tab runs the engine on NIFTY, BANK NIFTY and FIN NIFTY (Dhan live data on the phone,
simulated in demo; one scan takes ~10 s because Dhan allows one option chain per 3 s) and ranks them:

- **Verdict** GOOD NOW / CAUTION / AVOID / NO NEW TRADES and a 0–100 suitability score: the engine's
  confidence (40%), how cleanly the index is moving over the last hour (efficiency, 25), whether the trend
  agrees with the side (15), sane volatility (10) and whether ENTER would be allowed under your settings (10),
  minus penalties for chop, an over-extended day and expiry day.
- **If you ENTER at market now**: the strike, premium, quantity, SL, T1 and max loss under your sizing.
- **Why**: ✓ points for and ⚠ risks — sideways / counter-trend, choppy, extended range, opening gap, chasing
  the day high / low, expiry day or tomorrow, high IV, first 15 minutes, delayed data, refused entries.
- **Market today**: session phase, time left before your cutoff, whether the indexes agree, expiry days,
  your own day (trades used, P&L, no-revenge lockout) and a reminder that no news / events data is used.
- **MCX minis** (switch at the top): Gold, Silver, Crude Oil, Natural Gas, Lead, Zinc and Aluminium minis
  screened as futures — long / short, open-interest buildup instead of PCR / IV, MCX hours and your MCX
  cutoff, contract expiry / roll, an evening-session warning for gold, silver, crude and natural gas, and each
  contract's own lot cap (1 lot).
- **Trade … instead** switches the engine to that index. **Rescan every minute** is optional.

## Auto-refresh speed

Settings → Engine settings → **Auto-refresh interval**: minimum **3 seconds** (was 15). 3 s is the fastest
Dhan allows for the option chain (one request per 3 s per the API limits; the app paces requests itself, so
in practice a refresh lands every ~3–3.5 s). At fast rates the IV percentile still takes one snapshot per
15 s, routine saves happen at most every 15 s (trades, stop / lock moves, orders, setups and alerts save at
once), and the Dashboard follows the engine every 1.5 s.

## Portfolio: strategy results

The Portfolio tab opens with **Strategy results** from the trade journal, separately for PAPER and LIVE:
equity on the configured capital (paper capital; live capital when set), all-time and today's P&L including
the open trade, closed trades, win rate, wins/losses, profit factor, max drawdown, average win/loss,
best/worst, gross profit/loss, the open trade and the latest closed trades. PAPER also shows estimated NSE
option charges (₹20/order brokerage, STT, exchange, SEBI, stamp, GST) and the net after them; slippage is
not included. The older manual paper account (stocks and options bought from Markets / Option Chain) follows
below it. New journal rows record quantity, PAPER/LIVE and exit time.

## Log in / log out (Dhan)

Settings → **Dhan account**:

- **Log in with Client ID + 6-digit PIN.** Dhan's login (`POST auth.dhan.co/app/generateAccessToken`, as in
  their SDK) needs a TOTP code too; the app makes it itself from your **TOTP key**, saved once: web.dhan.co →
  Profile → DhanHQ Trading APIs → Set up TOTP, copy the key (or the otpauth:// link from the QR code) and paste
  it in the one-time field. The key is kept in the Android Keystore; the PIN is not stored; the 24-hour token
  is. The phone's clock must be set automatically. Dhan does not offer an API login with your web password.
- **Or paste an access token** generated on web.dhan.co.
- **Log in again (new token)** — for the daily token: same account, stays in LIVE.
- **Log out** — drops the token and switches to PAPER; refused while a LIVE position is open.
  **Log out and remove from this phone** also forgets the client ID and the TOTP key.
- Safety: every login turns **automatic LIVE entries off**; logging in with a **different** client ID also
  switches to **PAPER**, and is refused while the old account still has an open position.

## Entries: Manual / Automatic

Dashboard → Trading mode → **Entries**, set separately for PAPER and LIVE:

- **PAPER** — Automatic (default, as before): confirmed signals are traded on paper. Manual: they alert you
  and wait for ENTER.
- **LIVE** — Manual (default): confirmed signals only alert you. Automatic (asks for confirmation; turns
  auto-refresh on): each newly confirmed signal places a real market BUY through the same path as ENTER,
  so every gate is checked again (trades per day, no trade after a loss, daily max loss, entry cutoff,
  premium filters, max lots, capital) and the exchange stop-loss is placed on fill; one order per signal,
  never while a limit entry is pending or a position is open. Journaled as "Auto LIVE entry"; a refused or
  failed order shows as "Live order error - automatic entry failed: …" and raises an alert.
  **Switching into LIVE always starts in Manual.** Works while the app is running (Run in background).

## Cheap premium filter (options)

Settings → Engine settings → **Cheap premium filter**: **Minimum option premium** (default ₹40) and
**Maximum stop-loss as % of premium** (default 25%). A setup that fails either is skipped: the signal shows
`BLOCKED - …` with the reason and ENTER is refused. 0 switches a rule off. MCX futures are not affected.

## Entry cutoff

Settings → Engine settings → **No new trades after** (IST, default **14:35** for NIFTY / BANK NIFTY /
FIN NIFTY; a separate field for MCX, blank by default). From that time the engine arms no new setups,
drops any armed one, and refuses ENTER; an open trade keeps its stop, targets and profit lock until it exits.
Blank = no cutoff.

## Live P&L (Dashboard)

The Dashboard's top card shows the running P&L: the open trade in ₹ (including the half booked at Target 1),
its % on the capital put in, the price and move from entry, profit-lock status, today's booked P&L and today's
total including the open trade. Connected to Dhan, the phone quotes the open position about every 2 seconds
between engine refreshes (green dot = live price); stops, targets and the profit lock still act on each refresh
(and in LIVE the exchange stop at Dhan acts on its own).

## Day plan lock

Settings → **Day plan lock** (on by default; Target 2 off, Target 1 still books half):

- **Trade 1 of the day**: best profit ₹9,000 → ₹5,000 secured, ₹12,000 → ₹7,000, ₹14,000 → ₹10,000 (the
  highest step reached counts; below ₹9,000 the normal stop-loss applies). Above ₹14,000 the profit-lock
  ladder keeps trailing, never below ₹10,000 (₹20,000 → ₹15,000, ₹30,000 → ₹20,000, …).
- **Trade 2**, when trade 1 booked at least ₹10,000: its stop keeps the day's total at or above ₹10,000 —
  e.g. after a ₹14,000 trade 1 it may lose ₹4,000 at most (exits as `DAY FLOOR HIT`); after exactly ₹10,000
  it starts at break-even. As it gains, the profit-lock ladder applies on top.
- **Other trades** (trade 3+, or trade 2 after a smaller trade 1): the profit-lock ladder.

All amounts are editable; the stop only ever moves in the trade's favour and, in LIVE, the exchange stop at
Dhan follows it. The open-position card shows which rule the trade follows.

## Profit lock (trailing ₹)

Settings → **Profit lock** (off by default) trails the stop on the trade's total ₹ profit, including the half
booked at Target 1. It is one step behind the best profit, so small dips don't exit:

| Best profit | Secured |
|---|---|
| ₹10,000 | ₹5,000 |
| ₹15,000 | ₹10,000 |
| ₹20,000 | ₹15,000 |
| ₹25,000 | ₹20,000 |
| ₹30,000 | ₹20,000 (₹10,000 riding) |
| ₹35,000 / ₹42,000 | ₹25,000 / ₹32,000 (trails ₹10,000 below the peak) |

All four amounts are editable (start, step, ride level, ride amount). The stop only moves in the trade's
favour; Target 1 still books half; Target 2 is off while the lock is on. In LIVE the exchange stop order at
Dhan is replaced at the new level. Exits are journaled as `PROFIT LOCK HIT (Rs … secured)`, and each lock
raise is an alert ("Profit locked / raised"). A single-lot trade still exits in full at Target 1.

## Export (journal & logs)

Journal tab → **Export** shares a file (WhatsApp, Gmail, Drive, Files…):

- **Trade journal (CSV)** — every trade with entry / SL / target / exit, P&L, WIN/LOSS, confidence, trend,
  PCR, OI bias, IV, delta and entry / exit reasons.
- **Decision log (CSV)** — a row whenever the engine's decision, signal or position changes, on every new
  5-min candle, and for every refresh error: spot, trend, signal, confidence, CE/PE (long/short) scores,
  pattern, PCR, IV percentile, every factor's points, decision text, position, realized P&L, status.
  Keeps the latest 3,000 rows; clearing the journal keeps it.
- **Alerts & events (CSV)** — entries, partials, exits, signals (latest 100).
- **Everything (JSON)** — all of the above plus settings and win-rate / P&L stats. Dhan id and token are
  never included.

## Phone-only setup (no server)

1. ⚙ Settings → **Dhan account (this phone)**: enter your Dhan client id and access token and tap **Save & test**. They are checked with Dhan and stored only on the phone, encrypted by the Android Keystore.
2. **Static IP (for LIVE orders)**: enter the static IP whitelisted on your Dhan account, tap **Save**, and **Register with Dhan** if Dhan doesn't have it yet. Dhan accepts orders only from that IP, so for LIVE trading the phone must be online through it: your static-IP Wi-Fi, or a dedicated-IP VPN on the phone. Market data works from any network.
3. **Pre-flight check**: verifies the token, live data, option chain + Greeks, funds, the static IP, that the phone is actually online through it (public-IP lookup), that Dhan has it whitelisted, the underlying (NIFTY) and market hours. It runs automatically before switching to LIVE, and any ✘ blocks LIVE.

**Dashboard → Trading mode**

- **PAPER** (default): the engine paper-trades its signals, like the workbook. Nothing is sent to Dhan.
- **LIVE**: confirmed signals are **not** traded automatically; they show *SIGNAL CONFIRMED - tap ENTER*.
  - **ENTER** places a market BUY for the engine's plan (strike, lots sized to max risk), then a STOP_LOSS sell order at Dhan at the plan's SL, so the stop holds even when the app is closed.
  - While the app is open, T1 books half at market and re-places the stop at breakeven, and T2 or the trailing stop sells the rest.
  - If the exchange stop filled while the app was closed, the position is closed on the next refresh at the real fill.
  - **Buy price:** the box shows the live market premium; leave it as is to buy at market, or change it (0.05 steps) to place a limit order at your price (**Use market price** switches back). A limit below the premium waits as **Entry order pending**, checked on every refresh, with a **Cancel entry order** button. SL, T1 and T2 keep their distances from the actual fill. In PAPER the same limit logic is simulated.
  - **EXIT** cancels the stop and sells at market.
  - The journal records real fill prices, and Portfolio/Orders show your Dhan account.
- You can't switch between PAPER and LIVE while a position is open. Every live order asks for confirmation, and daily limits (trades/day, no revenge trade, ₹ max loss) apply to manual entries too.

**Limits:** the engine runs only while the app is open (Android pauses background apps); the exchange stop is what protects you when it's closed. LIVE supports NIFTY options. Product is Intraday (Dhan squares off before close) or Carry forward (NRML), set in Settings.

## Server setup (optional, not needed for phone-only use)

Run this on your **static-IP machine** (Ubuntu/Debian with systemd, for example a cloud VPS):

```bash
curl -fsSL https://raw.githubusercontent.com/premgurusamy-bot/Nifty-mobile/ccr-f60cf00a-vmzuuf/server/setup.sh -o setup.sh
sudo bash setup.sh
```

The script:

- installs Node 22 if needed, puts the app in `/opt/nifty-trader`, and creates a `nifty` service user
- asks for your **Dhan client id and access token** (typed on your server, hidden, saved only in `/opt/nifty-trader/server/.env`, mode 600), whether to enable live orders, optional Telegram alerts, and an optional domain for HTTPS (Caddy)
- generates the app access key
- **checks your credentials against Dhan**: token validity, NIFTY quote, expiries, option chain with Greeks
- starts the `nifty-trader` systemd service, which restarts on failure and on reboot
- prints the **Server URL** and **Access key** to type into the app (⚙ Settings → Dhan server)

Re-run the same command to update to the latest code; your settings are kept.

After installing:

- **Cloud firewall:** open inbound TCP 8787 (or 80/443 with a domain) in your provider's firewall or security group.
- **Live orders:** whitelist the server's static IP at web.dhan.co → Profile → DhanHQ Trading APIs.
- **Token:** the server checks the token every 30 minutes and renews it (`/v2/RenewToken`) about 2 hours before expiry, saving the new one to `.env`. If it has already expired, generate a new token at web.dhan.co and run `cd /opt/nifty-trader && sudo -u nifty npm run set-token && sudo systemctl restart nifty-trader`. The dashboard shows a red banner while the token is invalid.
- **Useful commands:** `journalctl -u nifty-trader -f` (logs), `sudo -u nifty npm run check` (test Dhan from `/opt/nifty-trader`).
- **Import your Excel history:** `pip install openpyxl`, stop the service, then run `python3 scripts/import_workbook.py <workbook.xlsm> server/data/engine.json`. The importer never reads the token or client-ID cells. It drops an open position from an earlier day, because that weekly contract has expired; `--keep-position` overrides.
- **Orders:** `LIVE_ORDERS=false` by default, and Portfolio/Orders paper-trade on live Dhan prices. With `true`, the order ticket places **real** orders. The app confirms every order, and the server enforces lot size, tick size and `MAX_ORDER_VALUE`.
- **Security:** without a domain the app connects over plain `http://IP:8787`, and the access key is sent unencrypted. Use a domain (HTTPS) if you enable live orders.

Other platforms: install Node ≥ 22.18, copy `server/.env.example` to `server/.env`, fill it in, and run `npm run server` from the repo root.

## App setup

```bash
npm install
npm start            # press a / i / w, or scan the QR code with Expo Go
```

Open ⚙ Settings, then enter the server URL and `APP_API_KEY` and tap **Save & test connection**. The key is stored in the device keychain. Clear them (Disconnect) to return to demo mode.

Installable Android APK (sideload on your phone): `npx eas-cli@latest build -p android --profile preview`.
Play Store bundle: `--profile production`. Local build with the Android SDK installed: `npx expo prebuild -p android && cd android && ./gradlew assembleRelease`.

## Development

```bash
npm test               # 43 tests: golden workbook match, engine rules, Dhan mapping, server API
npm run typecheck
npm run server:fake-dhan   # local fake Dhan API on :9900 (serves the workbook's real 27-Aug data)
```

`tests/fakeDhan.ts` mimics Dhan's v2 endpoints, using the request formats from Dhan's official Python SDK (dhanhq 2.3.0). The integration tests check exactly what would be sent to Dhan (headers, security IDs, segments, product types, tick rounding).

**Not tested here:** live calls to api.dhan.co, which weren't reachable from the build environment. The first time you run against your real account, watch `server` logs and the dashboard status line.

```
src/lib/engine/   ported decision engine (pure TS)
src/lib/          instruments, Black-Scholes, simulator, paper-trading engine, formatting
src/app/          Expo Router screens
src/state/        settings, engine, market data and portfolio contexts
server/           Dhan client, mapping, engine runner, HTTP API
scripts/          workbook importer
tests/            node:test suites, fake Dhan, golden fixture
```
