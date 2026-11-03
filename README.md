# Nifty Trader (mobile)

Your **NIFTY Option Buying System** (the `NIFTY_Option_System_v4` Excel/VBA workbook) as a mobile app, on the **Dhan HQ API v2**.

The workbook's decision engine was ported rule for rule to TypeScript. A golden test checks it against the workbook's own last refresh (27-Aug-2026 11:40 IST): fed the same candles, option chain and IV history, the app reproduces Excel's EMA20/EMA50/VWAP/ATR on all 225 candles. It also matches PCR, Max Pain, OI support/resistance, swing levels, the **88.898 confidence score with all 10 factor scores**, the Greeks and the IV snapshot.

> Decision-support tool, like the workbook. The engine only **signals** and paper-tracks its position; it never places orders by itself. Confidence and R:R are a filter, not a prediction.

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
| `runner.ts` | `modMain.RefreshAll` / auto-refresh loop (market-hours gated, 15 s floor) |

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
  dashboard, journal,                       • runs the engine every 15 s in market hours
  chain, orders                             • holds your Dhan token (never on the phone)
                                            • journal / IV history in server/data/engine.json
                                            • respects Dhan rate limits, Telegram alerts
```

The engine runs on the **server**, as Excel's `OnTime` loop did, so stop losses and targets are tracked even while your phone is locked. Without a server, the app runs the same engine in **demo mode** on an accelerated NIFTY simulation (each refresh = one 5-minute candle).

## Connect without a server (Dhan account on the phone)

⚙ Settings → **Dhan account (this phone)**: enter your Dhan client id and access token and tap **Save & test**. The app checks them with Dhan (token + NIFTY quote) and saves them on the phone only, encrypted by the Android Keystore (`expo-secure-store`). The same server code then runs inside the app, so the Dashboard engine, live option chain, markets, journal and paper trading all work straight from Dhan.

Limits of phone-only mode:
- **No real orders:** Dhan only accepts order APIs from your whitelisted static IP. Portfolio/Orders paper-trade on live prices.
- **Engine runs only while the app is open:** Android pauses background apps, so SL/target monitoring stops while the phone is locked.
- **Token renewal:** the token is renewed automatically while the app is open. If it expires, paste a new one and tap **Update & test**.

For live orders and round-the-clock monitoring, use the server below. When a server is connected it takes priority; the phone credentials stay saved but unused.

## Server setup

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
