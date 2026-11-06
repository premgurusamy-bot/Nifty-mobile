/**
 * Profit lock: a ₹ trailing stop on the trade's total profit (booked half + open part).
 *
 * One step behind the peak, so normal wiggles don't exit the trade:
 *   peak ≥ start               → secure start − step, +step for every further step reached
 *                                (10k → 5k, 15k → 10k, 20k → 15k, 25k → 20k …)
 *   the step lock stops rising at the ride level (rideFrom); above it the trade may
 *   give back up to rideAmount from its peak, never less than what is already secured
 *                                (25k → 20k, 30k → 20k, 35k → 25k, 42k → 32k)
 * With profit lock on, Target 2 is off (the lock decides the exit); Target 1 still books half.
 */
import type { EngineConfig, OpenPosition } from './types.ts';

type LockCfg = Pick<EngineConfig, 'lockStart' | 'lockStep' | 'lockRideFrom' | 'lockRideAmount'>;

/** Profit (₹) secured for a trade whose best total profit so far is `peak`; null = not engaged yet. */
export function lockedProfit(peak: number, c: LockCfg): number | null {
  const start = c.lockStart;
  const step = c.lockStep;
  if (!(start > 0) || !(step > 0) || !(peak >= start)) return null;
  const steps = Math.floor((peak - start) / step + 1e-9);
  let lock = start + (steps - 1) * step;
  const ride = c.lockRideFrom > 0 && c.lockRideAmount > 0;
  if (ride) {
    lock = Math.min(lock, c.lockRideFrom);
    if (peak >= c.lockRideFrom) lock = Math.max(lock, peak - c.lockRideAmount);
  }
  return Math.max(0, lock);
}

type DayPlanCfg = LockCfg &
  Pick<EngineConfig, 'dayPlanLock' | 'profitLock' | 'dl1At' | 'dl1Lock' | 'dl2At' | 'dl2Lock' | 'dl3At' | 'dl3Lock' | 'dayFloor'>;

/** Trade 1 ladder: the highest step reached (null below the first step). */
export function firstTradeLock(peak: number, c: DayPlanCfg): number | null {
  if (peak >= c.dl3At) return Math.max(c.dl3Lock, lockedProfit(peak, c) ?? -Infinity); // keeps trailing above
  if (peak >= c.dl2At) return c.dl2Lock;
  if (peak >= c.dl1At) return c.dl1Lock;
  return null;
}

/**
 * Profit (₹, on this trade) the stop must secure now. Can be negative for trade 2 under the day
 * plan: "the day may still end ≥ dayFloor" allows that much loss on it. null = no lock yet.
 */
export function lockFor(p: Pick<OpenPosition, 'dayPlan' | 'dayBooked'>, peak: number, c: DayPlanCfg): number | null {
  if (!c.dayPlanLock) return c.profitLock ? lockedProfit(peak, c) : null;
  if (p.dayPlan === 'FIRST') return firstTradeLock(peak, c);
  const ladder = lockedProfit(peak, c);
  if (p.dayPlan === 'SECOND') return Math.max(c.dayFloor - (p.dayBooked ?? 0), ladder ?? -Infinity);
  return ladder;
}

/** Which day-plan rule a new trade follows: by how many trades came before it today and what they booked. */
export function dayPlanFor(tradesBefore: number, bookedToday: number, c: Pick<EngineConfig, 'dayPlanLock' | 'dayFloor'>) {
  if (!c.dayPlanLock) return undefined;
  if (tradesBefore === 0) return 'FIRST' as const;
  if (tradesBefore === 1 && bookedToday >= c.dayFloor) return 'SECOND' as const;
  return 'NORMAL' as const;
}
