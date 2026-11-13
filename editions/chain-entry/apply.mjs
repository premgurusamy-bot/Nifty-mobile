// Option Chain BUY → engine trade, the same for v2 and the licensed v1.
//   node editions/chain-entry/apply.mjs <app dir> <this repo's dir>
// Adds: EngineRunner.entryPlan(pick) / placeEntry(limit, pick) — the engine's plan (stop, Target 1,
// profit lock, day plan, daily rules) for the strike you picked in the Option Chain, with your
// quantity (whole lots, max-lots cap); the phone API call engineEnterStrike; EngineContext.enterStrike.
// (The order ticket, src/app/order.tsx, and the live trader take the pick themselves.) Idempotent.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [dir, src] = process.argv.slice(2);
if (!dir || !src) throw new Error('usage: node apply.mjs <app dir> <source dir>');
if (resolve(dir) !== resolve(src)) copyFileSync(join(src, 'src/app/order.tsx'), join(dir, 'src/app/order.tsx'));

function patch(file, from, to, times = 1) {
  const path = join(dir, file);
  const text = readFileSync(path, 'utf8');
  if (text.includes(to)) return;
  const n = text.split(from).length - 1;
  if (n !== times) throw new Error(`${file}: expected ${times}× but found ${n}×: ${from.slice(0, 60)}`);
  writeFileSync(path, text.split(from).join(to));
}

// ---- engine: a plan for the strike you picked ----
patch(
  'src/lib/engine/runner.ts',
  'export class EngineRunner {\n',
  `/** A strike picked in the Option Chain (BUY), traded by the engine: quantity in units (whole lots). */
export type EntryPick = { direction: 'CE' | 'PE'; strike: number; qty?: number };

export class EngineRunner {
`,
);
patch(
  'src/lib/engine/runner.ts',
  "  entryPlan(): TradePlan {\n    if (this.state.position) throw new Error('A position is already open — exit it first.');\n",
  "  entryPlan(pick?: EntryPick): TradePlan {\n    if (this.state.position) throw new Error('A position is already open — exit it first.');\n",
);
patch(
  'src/lib/engine/runner.ts',
  '    const plan = d.candidatePlan ?? this.planFor(d.decision.direction, d.decision.selectedStrike, d.market.atr);\n    if (!plan || plan.entry <= 0)',
  '    if (pick) return this.pickedPlan(pick, d.market.atr);\n    const plan = d.candidatePlan ?? this.planFor(d.decision.direction, d.decision.selectedStrike, d.market.atr);\n    if (!plan || plan.entry <= 0)',
);
patch(
  'src/lib/engine/runner.ts',
  '  /**\n   * Manual ENTER in paper mode. Without a limit, or with a limit the market has\n',
  `  /**
   * The engine's plan for a strike picked in the Option Chain: its stop and targets from the engine
   * (same rules as ENTER), your quantity in whole lots (never above Max lots). The daily rules were
   * already checked by entryPlan; the premium filters and lot sizing don't override your choice.
   */
  private pickedPlan(pick: EntryPick, atr: number): TradePlan {
    const chain = this.lastChain!;
    const row = chain.strikes.find((s) => s.strike === pick.strike);
    const leg = row?.[pick.direction === 'CE' ? 'ce' : 'pe'];
    if (!leg || !(leg.ltp > 0))
      throw new Error(\`\${pick.strike} \${pick.direction} isn't in the engine's option chain (\${chain.expiry}) — refresh, or pick a strike nearer the money.\`);
    const plan = this.planFor(pick.direction, pick.strike, atr);
    if (!plan || plan.entry <= 0) throw new Error(\`No price for \${pick.direction} \${pick.strike}\`);
    const lot = this.config.lotSize || 1;
    let lots: number;
    let note = '';
    if (pick.qty != null) {
      lots = Math.floor(pick.qty / lot);
      if (lots < 1) throw new Error(\`Quantity must be at least 1 lot (\${lot})\`);
      if (this.config.maxLots > 0 && lots > this.config.maxLots) {
        note = \` (capped at max lots \${this.config.maxLots})\`;
        lots = this.config.maxLots;
      }
    } else {
      if (plan.blocked || plan.qty <= 0) throw new Error(plan.blocked ?? 'Position size is 0 lots');
      lots = Math.round(plan.qty / lot);
    }
    const qty = lots * lot;
    const { blocked: _blocked, ...rest } = plan;
    return {
      ...rest,
      qty,
      maxLoss: plan.riskPts * qty,
      potentialProfit: (plan.target1 - plan.entry) * qty,
      sizing: \`Option Chain: \${lots} lot(s) you chose\${note}\`,
    };
  }

  /**
   * Manual ENTER in paper mode. Without a limit, or with a limit the market has
`,
);
patch(
  'src/lib/engine/runner.ts',
  "  async placeEntry(limit?: number) {\n    if (this.state.pendingEntry) throw new Error('An entry order is already pending — cancel it first.');\n    const plan = this.entryPlan();\n",
  "  async placeEntry(limit?: number, pick?: EntryPick) {\n    if (this.state.pendingEntry) throw new Error('An entry order is already pending — cancel it first.');\n    const plan = this.entryPlan(pick);\n",
);

// ---- phone API ----
patch(
  'src/api/localApi.ts',
  '  engineCancelEntry: () => Promise<EngineSnapshot>;\n',
  `  engineCancelEntry: () => Promise<EngineSnapshot>;
  /** Option Chain BUY as an engine trade (the engine's stop / targets / profit lock; your quantity). */
  engineEnterStrike: (p: { symbol: string; direction: 'CE' | 'PE'; strike: number; qty?: number; limit?: number; expiry?: string }) => Promise<EngineSnapshot>;
`,
);
patch(
  'src/api/localApi.ts',
  '    engineCancelEntry: async () => {\n',
  `    engineEnterStrike: async (p) => {
      // Manual actions run between engine cycles where the engine supports it.
      const ex = <T,>(fn: () => Promise<T>) => {
        const e = engine as unknown as { exclusive?: (f: () => Promise<T>) => Promise<T> };
        return e.exclusive ? e.exclusive(fn) : fn();
      };
      if (engine.config.symbol !== p.symbol) {
        const m = engine as unknown as { multiActive?: () => boolean; setActive?: (s: string) => Promise<void> };
        if (!m.multiActive?.() || !m.setActive)
          throw new Error(\`The engine trades \${engine.config.symbol}: choose \${p.symbol} as the instrument in Settings to trade it with the engine.\`);
        await ex(() => m.setActive!(p.symbol));
      }
      if (!engine.dashboard) await engine.refresh();
      const exp = engine.dashboard?.expiry;
      if (p.expiry && exp && p.expiry !== exp)
        throw new Error(\`The engine trades the \${exp} expiry — pick the strike from that expiry (this one is \${p.expiry}).\`);
      const pick = { direction: p.direction, strike: p.strike, qty: p.qty };
      await ex(async () => {
        if (live()) await trader.enter(engine, p.limit, { pick });
        else await engine.placeEntry(p.limit, pick);
      });
      return engine.snapshot();
    },
    engineCancelEntry: async () => {
`,
);

// ---- EngineContext ----
patch(
  'src/state/EngineContext.tsx',
  '  cancelEntry: () => Promise<void>;\n',
  "  cancelEntry: () => Promise<void>;\n  /** Option Chain BUY as an engine trade (stop-loss, Target 1, profit lock; your quantity). */\n  enterStrike: (p: { symbol: string; direction: 'CE' | 'PE'; strike: number; qty?: number; limit?: number; expiry?: string }) => Promise<void>;\n",
);
patch(
  'src/state/EngineContext.tsx',
  '  const cancelEntry = useCallback(\n',
  `  const enterStrike = useCallback(
    (p: { symbol: string; direction: 'CE' | 'PE'; strike: number; qty?: number; limit?: number; expiry?: string }) =>
      run(async () => {
        if (phoneApi) return phoneApi.engineEnterStrike(p);
        if (api) throw new Error('Engine entries from the Option Chain need the phone connection.');
        const r = demo.current!;
        if (r.config.symbol !== p.symbol) throw new Error(\`The demo engine trades \${r.config.symbol}.\`);
        await r.placeEntry(p.limit, { direction: p.direction, strike: p.strike, qty: p.qty });
        return r.snapshot(true);
      }),
    [api, phoneApi, run],
  );

  const cancelEntry = useCallback(
`,
);
patch('src/state/EngineContext.tsx', '      cancelEntry,\n', '      cancelEntry,\n      enterStrike,\n', 2);
console.log('Option Chain → engine entry applied');
