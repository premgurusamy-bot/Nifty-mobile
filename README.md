# Nifty Trader (mobile)

A React Native / Expo app for **paper trading** NIFTY 50 stocks and NIFTY weekly options. It runs on Android, iOS and web from one TypeScript codebase.

> ⚠️ **Simulated data, virtual money.** Prices come from a built-in market simulator and options are priced with Black-Scholes. Nothing here is investment advice, and the app places no real orders. See [Connecting a real broker](#connecting-a-real-broker) to go live.

## Features

| Tab | What it does |
| --- | --- |
| **Markets** | NIFTY 50 index card with an intraday chart, OHLC and prev. close, plus a live-ticking watchlist of 16 constituents with sparklines |
| **Option Chain** | NIFTY calls and puts for the next 3 weekly (Tuesday) expiries: premiums, delta, IV smile, ITM shading. Tap a premium to trade it |
| **Portfolio** | Account value, cash, invested amount, unrealised/realised P&L, charges and positions marked to market. Includes a reset button |
| **Orders** | Order book showing OPEN, FILLED, CANCELLED and REJECTED orders with reasons. Open limit orders can be cancelled |

- **Order ticket:** Buy or Sell, Market or Limit. Options are traded in lots (lot size 65), equities in shares.
- **Paper engine:** starts with ₹10,00,000 virtual cash and charges a flat ₹20 brokerage per fill. It checks funds and quantity, and resting limit orders fill when the price crosses the limit.
- **Saved on device:** the portfolio is stored with AsyncStorage, so it survives restarts.
- **Market clock:** shows the NSE session state (pre-open 09:00–09:15, open 09:15–15:30 IST, Mon–Fri) and formats numbers the Indian way (₹12,34,567.89).

### Simplifications (deliberate, for a v1)
- Long-only: SELL can only close a position you hold. There is no short selling or margin.
- Exchange holidays, expiry settlement, taxes, STT and GST are not modelled.
- The NIFTY lot size and weekly expiry day change from time to time. Check `NIFTY_LOT_SIZE` in `src/lib/instruments.ts` and `nextWeeklyExpiry` in `src/lib/time.ts` against current NSE circulars.

## Getting started

```bash
npm install
npm start          # then press a (Android), i (iOS) or w (web), or scan the QR with Expo Go
```

Other scripts:

```bash
npm test           # unit tests for the trading engine, options pricing, market clock (node:test)
npm run typecheck  # tsc --noEmit
npx expo export --platform web   # static web build in dist/
```

To build installable apps, use EAS: `npx eas-cli@latest build -p android` (or `-p ios`).

## Project layout

```
src/
  app/                    Expo Router screens (file-based routing)
    _layout.tsx           Root stack, theme and providers
    (tabs)/               Markets, Option Chain, Portfolio, Orders
    instrument/[id].tsx   Instrument detail with chart and Buy/Sell
    order.tsx             Order ticket (modal)
  lib/                    Pure TypeScript with no React, unit-tested
    simulator.ts          Correlated random-walk market feed
    blackScholes.ts       Option pricing, IV smile
    optionChain.ts        Chain builder, option pricing by ID
    portfolio.ts          Paper-trading engine (orders, fills, P&L)
    instruments.ts        Symbols, lot size, instrument IDs
    time.ts               IST market hours, weekly expiries
    format.ts             Indian number and ₹ formatting
  state/                  React context: live market feed and saved portfolio
  components/             Chart, quote row, UI primitives
tests/                    node:test suites for src/lib
```

Instrument IDs: `NSE:NIFTY 50`, `NSE:RELIANCE`, `NFO:NIFTY:2026-11-10:26000:CE`.

## Connecting a real broker

All market data flows through `src/state/MarketContext.tsx`, which exposes `quotes`, `history`, `spot` and `getPrice(id)`. To use live data:

1. Pick a broker API, such as Zerodha Kite Connect, Upstox, Angel One SmartAPI or Dhan.
2. **Run a small backend.** Broker API secrets and the OAuth login flow must not ship inside the mobile app. The backend completes the login, keeps the access token, and relays the broker's WebSocket ticks to the app.
3. Replace the simulator `setInterval` in `MarketContext` with a WebSocket subscription to your backend, and map the ticks into the `Quote` shape.
4. For real orders, change `placeOrder` and `cancelOrder` in `PortfolioContext` to call your backend instead of the local engine, then load positions and orders from the broker.

Live trading also brings regulatory duties (SEBI rules for algo and retail API trading, and the broker's own app-registration terms). Read them before going live.
