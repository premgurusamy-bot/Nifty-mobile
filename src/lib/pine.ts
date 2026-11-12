/**
 * TradingView Pine Script (v5) versions of the app's indicators and strategy, made from your
 * current settings: paste them into TradingView's Pine Editor and add them to an index chart
 * (NIFTY / BANKNIFTY / FINNIFTY, 5-minute candles).
 *
 * TradingView sees only the chart's price and volume — not the option chain — so:
 *  - the score uses the app's price-based factors only (EMA trend 15, VWAP position 10, price
 *    action 10, volume 5 → scaled to 0–100); PCR, OI bias, delta, IV, gamma and theta can't be used;
 *  - the strategy trades the index, sized so ₹ P&L ≈ an option of the given delta
 *    (index points × delta × lots × lot size); the ₹ profit lock works on that estimate.
 * Rules mirrored: setup at the trade level → entry on the break of that candle within N candles,
 * entry window, max trades / day, no-revenge rule, gap guard (first 15 minutes), stop = ATR ×
 * multiplier, Target 1 books 50% at risk × RR (stop to breakeven), Target 2 off when the profit
 * lock is on, and the ₹ profit lock ladder (start / step / ride level / ride amount).
 */
import type { EngineConfig } from './engine/types';

type Cfg = Pick<
  EngineConfig,
  | 'symbol'
  | 'lotSize'
  | 'atrMult'
  | 'rrTarget'
  | 'confHigh'
  | 'maxTradesPerDay'
  | 'lastEntryTime'
  | 'profitLock'
  | 'dayPlanLock'
  | 'lockStart'
  | 'lockStep'
  | 'lockRideFrom'
  | 'lockRideAmount'
  | 'sizingMode'
  | 'fixedLots'
  | 'maxLots'
> & {
  /** Gap guard (v2 settings; the licensed v1 has none, so it starts off there). */
  gapGuard?: boolean;
  gapGuardPct?: number;
};

const num = (n: number | undefined, d: number) => (Number.isFinite(n) ? Number(n) : d);
const endHHMM = (s: string | undefined) => (/^\d{2}:\d{2}$/.test(s ?? '') ? s!.replace(':', '') : '1500');

/** Shared Pine block: the app's price-based score factors (CE / PE, 0–100). */
const SCORE_BLOCK = `ema20 = ta.ema(close, 20)
ema50 = ta.ema(close, 50)
vwapV = ta.vwap(hlc3)
// EMA trend (15): bullish → CE, bearish → PE, sideways → 6 to both (as in the app)
bull = ema20 > ema50 and close > ema20
bear = ema20 < ema50 and close < ema20
emaCE = bull ? 15.0 : bear ? 0.0 : 6.0
emaPE = bear ? 15.0 : bull ? 0.0 : 6.0
// VWAP position (10): clearly past VWAP 10, just past 5
vwPct = (close - vwapV) / vwapV * 100
vwCE = vwPct > 0.05 ? 10.0 : vwPct > 0 ? 5.0 : 0.0
vwPE = vwPct < -0.05 ? 10.0 : vwPct < 0 ? 5.0 : 0.0
// Price action (10): close beyond the previous candle 10, a candle the right colour 5
paCE = close > high[1] ? 10.0 : close > open ? 5.0 : 0.0
paPE = close < low[1] ? 10.0 : close < open ? 5.0 : 0.0
// Volume (5): above its 20-candle average, to the candle's side
volHi = volume > ta.sma(volume, 20)
voCE = volHi and close > open ? 5.0 : 0.0
voPE = volHi and close < open ? 5.0 : 0.0
scoreCE = (emaCE + vwCE + paCE + voCE) / 40 * 100
scorePE = (emaPE + vwPE + paPE + voPE) / 40 * 100`;

/** The strategy (overlay on the index chart). */
export function pineStrategy(c: Cfg): string {
  const lots = c.sizingMode === 'FIXED' ? num(c.fixedLots, 1) : num(c.maxLots, 10);
  const lockOn = !!(c.profitLock || c.dayPlanLock);
  return `// Nifty Trader — app strategy for TradingView (made by the app from your settings)
// Add to a 5-minute ${c.symbol} chart. Uses price and volume only: the app's option-chain factors
// (PCR, OI, delta, IV, gamma, theta) are not available in TradingView. P&L is an estimate of the
// option's (index points × delta × quantity).
//@version=5
strategy("Nifty Trader — strategy", overlay=true, initial_capital=200000, currency=currency.INR, default_qty_type=strategy.fixed, default_qty_value=1, pyramiding=0, process_orders_on_close=false)

lots      = input.int(${lots}, "Lots", minval=1)
lotSize   = input.int(${num(c.lotSize, 65)}, "Lot size", minval=1)
optDelta  = input.float(0.5, "Option delta (₹ per index point per unit)", minval=0.05, maxval=1, step=0.05)
atrMult   = input.float(${num(c.atrMult, 1.5)}, "Stop = ATR ×", minval=0.1, step=0.1)
rr        = input.float(${num(c.rrTarget, 2)}, "Target 1 = risk ×", minval=0.1, step=0.1)
scoreMin  = input.float(${num(c.confHigh, 80)}, "Trade level (score 0–100)", minval=0, maxval=100)
holdBars  = input.int(3, "Setup valid for (candles)", minval=1)
window    = input.session("0930-${endHHMM(c.lastEntryTime)}", "Entry window (IST)")
maxTrades = input.int(${num(c.maxTradesPerDay, 3)}, "Max trades / day", minval=1)
noRevenge = input.bool(true, "No-revenge rule (no new trade after a loss)")
gapGuard  = input.bool(${c.gapGuard ? 'true' : 'false'}, "Gap guard (wait 15 minutes after a big gap)")
gapPct    = input.float(${num(c.gapGuardPct, 0.5)}, "Gap guard %", minval=0.1, step=0.1)
useLock   = input.bool(${lockOn}, "Profit lock (Target 2 off)")
lockStart = input.float(${num(c.lockStart, 10000)}, "Lock: start ₹")
lockStep  = input.float(${num(c.lockStep, 5000)}, "Lock: step ₹")
rideFrom  = input.float(${num(c.lockRideFrom, 20000)}, "Lock: stop stepping at ₹ (0 = keep stepping)")
rideAmt   = input.float(${num(c.lockRideAmount, 10000)}, "Lock: trail ₹ above that")

${SCORE_BLOCK}
atr = ta.atr(14)
qtyUnits = lots * lotSize * optDelta

plot(ema20, "EMA 20", color=color.new(color.orange, 0))
plot(ema50, "EMA 50", color=color.new(color.purple, 0))
plot(vwapV, "VWAP", color=color.new(color.blue, 0), style=plot.style_circles, linewidth=1)

// ---- day counters, gap guard
newDay = ta.change(time("D")) != 0
var int tradesToday = 0
var bool lostToday = false
var int dayBar = 0
var float prevDayClose = na
var float dayOpen = na
if newDay
    tradesToday := 0
    lostToday := false
    dayBar := 0
    prevDayClose := close[1]
    dayOpen := open
else
    dayBar += 1
bigGap = gapGuard and not na(prevDayClose) and math.abs(dayOpen - prevDayClose) / prevDayClose * 100 >= gapPct
gapWait = bigGap and dayBar < 3
inWindow = not na(time(timeframe.period, window, "Asia/Kolkata"))
flat = strategy.position_size == 0
canTrade = inWindow and not gapWait and tradesToday < maxTrades and not (noRevenge and lostToday)

// ---- setup: a finished candle at the trade level; entry when price breaks it
var float trig = na
var int trigDir = 0
var int trigBar = na
if flat and canTrade and scoreCE >= scoreMin and scoreCE >= scorePE
    trig := high
    trigDir := 1
    trigBar := bar_index
else if flat and canTrade and scorePE >= scoreMin and scorePE > scoreCE
    trig := low
    trigDir := -1
    trigBar := bar_index
setupLive = trigDir != 0 and bar_index - trigBar <= holdBars
if trigDir != 0 and not setupLive
    strategy.cancel("CE")
    strategy.cancel("PE")
    trigDir := 0
if flat and canTrade and setupLive and trigDir == 1
    strategy.entry("CE", strategy.long, qty=qtyUnits, stop=trig)
if flat and canTrade and setupLive and trigDir == -1
    strategy.entry("PE", strategy.short, qty=qtyUnits, stop=trig)
plotshape(trigDir == 1 and trigBar == bar_index, "CE setup", shape.triangleup, location.belowbar, color.new(color.green, 0), size=size.tiny)
plotshape(trigDir == -1 and trigBar == bar_index, "PE setup", shape.triangledown, location.abovebar, color.new(color.red, 0), size=size.tiny)

// ---- ₹ profit lock (same ladder as the app)
f_lock(pk) =>
    float res = na
    if useLock and lockStep > 0 and pk >= lockStart
        steps = math.floor((pk - lockStart) / lockStep + 1e-9)
        lk = lockStart + (steps - 1) * lockStep
        if rideFrom > 0 and rideAmt > 0
            lk := math.min(lk, rideFrom)
            if pk >= rideFrom
                lk := math.max(lk, pk - rideAmt)
        res := math.max(0, lk)
    res

// ---- trade management: stop, Target 1 (50%), breakeven, lock
var float riskPts = na
var float stopPx = na
var float entryPx = na
var float peak = 0.0
var float netAtEntry = 0.0
var bool t1Done = false
side = math.sign(strategy.position_size)
justOpened = strategy.position_size != 0 and strategy.position_size[1] == 0
if justOpened
    entryPx := strategy.position_avg_price
    riskPts := atr * atrMult
    stopPx := entryPx - side * riskPts
    peak := 0.0
    netAtEntry := strategy.netprofit
    t1Done := false
    tradesToday += 1
    trigDir := 0
if strategy.position_size != 0
    if math.abs(strategy.position_size) < math.abs(strategy.position_size[1]) and not justOpened
        t1Done := true
        stopPx := side > 0 ? math.max(stopPx, entryPx) : math.min(stopPx, entryPx)
    booked = strategy.netprofit - netAtEntry
    total = booked + strategy.openprofit
    peak := math.max(peak, total)
    lk = f_lock(peak)
    if not na(lk)
        lockPx = entryPx + side * (lk - booked) / math.abs(strategy.position_size)
        stopPx := side > 0 ? math.max(stopPx, lockPx) : math.min(stopPx, lockPx)
    t1Px = entryPx + side * riskPts * rr
    t2Px = entryPx + side * riskPts * rr * 1.5
    name = side > 0 ? "CE" : "PE"
    if not t1Done
        strategy.exit("T1", from_entry=name, qty_percent=50, limit=t1Px, stop=stopPx)
    if useLock
        strategy.exit("Rest", from_entry=name, stop=stopPx)
    else
        strategy.exit("Rest", from_entry=name, stop=stopPx, limit=t2Px)
if strategy.position_size == 0 and strategy.position_size[1] != 0
    if strategy.netprofit - netAtEntry < 0
        lostToday := true
plot(strategy.position_size != 0 ? stopPx : na, "Stop", color=color.new(color.red, 0), style=plot.style_linebr, linewidth=2)
`;
}

/** The score panel (separate pane): CE / PE scores against the trade level. */
export function pineScore(c: Pick<EngineConfig, 'confHigh' | 'confWatch' | 'symbol'>): string {
  return `// Nifty Trader — score panel for TradingView (price-based factors of the app's score, 0–100)
// The app's full score also uses the option chain (PCR, OI, delta, IV, gamma, theta), so this panel
// can differ from the app's number.
//@version=5
indicator("Nifty Trader — score", overlay=false)
tradeLevel = input.float(${num(c.confHigh, 80)}, "Trade level")
watchLevel = input.float(${num(c.confWatch, 65)}, "Watch level")
${SCORE_BLOCK}
plot(scoreCE, "Score CE", color=color.new(color.green, 0), linewidth=2)
plot(scorePE, "Score PE", color=color.new(color.red, 0), linewidth=2)
hline(tradeLevel, "Trade level", color=color.new(color.gray, 0), linestyle=hline.style_dashed)
hline(watchLevel, "Watch level", color=color.new(color.gray, 60), linestyle=hline.style_dotted)
`;
}
