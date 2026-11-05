/**
 * Position sizing shared by the option and futures plans.
 *
 *  - RISK (the workbook): lots = max risk ÷ (stop distance × ₹ per point per lot), at least 1.
 *  - CAPITAL: lots = (capital × capital %) ÷ cost of one lot. Options cost premium × lot size;
 *    MCX futures cost the margin per lot (entered, or estimated). Paper and live capital are
 *    separate; live capital 0 uses the Dhan account's available balance.
 *
 * Either way the max-lots cap still applies (0 = no cap).
 */
import { formatINR } from '../format.ts';
import { EST_MARGIN_PCT, type EngineConfig } from './types.ts';

/** Engine config plus the live account balance the runner fetched (CAPITAL sizing in LIVE). */
export type SizingConfig = EngineConfig & { availableFunds?: number | null };

const inr = (n: number) => formatINR(n, 0);

/** Capital one trade may use, and where it came from. */
export function sizingCapital(cfg: SizingConfig): { capital: number; base: number; source: string } {
  const pct = Math.min(100, Math.max(0, cfg.capitalPct ?? 100));
  let base: number;
  let source: string;
  if (cfg.tradeMode === 'LIVE') {
    if ((cfg.capitalLive ?? 0) > 0) {
      base = cfg.capitalLive;
      source = 'live capital';
    } else {
      base = cfg.availableFunds ?? 0;
      source = cfg.availableFunds == null ? 'Dhan balance (not fetched yet)' : 'Dhan available balance';
    }
  } else {
    base = cfg.capitalPaper ?? 0;
    source = 'paper capital';
  }
  return { capital: (base * pct) / 100, base, source };
}

/** Margin (₹) one MCX futures lot blocks: the entered figure, else an estimate. */
export function futuresMarginPerLot(price: number, cfg: EngineConfig): { margin: number; estimated: boolean } {
  if ((cfg.marginPerLot ?? 0) > 0) return { margin: cfg.marginPerLot, estimated: false };
  return { margin: price * (cfg.pointValue || 1) * EST_MARGIN_PCT, estimated: true };
}

/**
 * Lots for one trade. riskPerLot = ₹ lost per lot at the stop; costPerLot = ₹ one lot
 * needs (premium × lot size, or margin). lots 0 + blocked when capital can't buy one lot.
 */
export function sizeLots(
  cfg: SizingConfig,
  riskPerLot: number,
  costPerLot: number,
  costLabel = 'per lot',
): { lots: number; sizing: string; blocked?: string } {
  const cap = cfg.maxLots > 0 ? cfg.maxLots : Infinity;
  if (cfg.sizingMode === 'FIXED') {
    const want = Math.max(1, Math.floor(cfg.fixedLots || 1));
    const lots = Math.min(want, cap);
    const capped = lots < want ? ` (max lots ${cfg.maxLots})` : '';
    // Can the capital pay for it? (LIVE with the balance not fetched yet: Dhan itself will refuse if not.)
    const { base: capital, source } = sizingCapital(cfg); // the whole capital: "% per trade" is for Capital mode
    const known = !(cfg.tradeMode === 'LIVE' && !(cfg.capitalLive > 0) && cfg.availableFunds == null);
    const sizing = `Fixed ${lots} lot(s)${capped} · max loss ${inr(riskPerLot * lots)}`;
    if (known && costPerLot > 0 && costPerLot * lots > capital) {
      return {
        lots: 0,
        sizing,
        blocked: `${lots} lot(s) need ${inr(costPerLot * lots)} (${costLabel} ${inr(costPerLot)}) but ${source} is ${inr(capital)}`,
      };
    }
    return { lots, sizing };
  }
  if (cfg.sizingMode !== 'CAPITAL') {
    const raw = Math.max(1, Math.floor(cfg.maxRisk / riskPerLot));
    const lots = Math.min(raw, cap);
    return {
      lots,
      sizing: `Risk ${inr(cfg.maxRisk)} ÷ ${inr(riskPerLot)} per lot → ${lots} lot(s)${lots < raw ? ` (max ${cfg.maxLots})` : ''}`,
    };
  }
  const { capital, base, source } = sizingCapital(cfg);
  const pct = cfg.capitalPct ?? 100;
  const what = `${inr(base)} ${source}${pct < 100 ? ` × ${pct}%` : ''}`;
  if (!(costPerLot > 0)) return { lots: 0, sizing: what, blocked: 'No price to size the trade' };
  const raw = Math.floor(capital / costPerLot);
  if (raw < 1) {
    return {
      lots: 0,
      sizing: `${what} → 0 lots`,
      blocked: `Capital ${inr(capital)} (${source}) can't buy 1 lot (${inr(costPerLot)} ${costLabel})`,
    };
  }
  const lots = Math.min(raw, cap);
  return {
    lots,
    sizing: `${what} ÷ ${inr(costPerLot)} ${costLabel} → ${lots} lot(s)${lots < raw ? ` (max ${cfg.maxLots})` : ''}`,
  };
}
