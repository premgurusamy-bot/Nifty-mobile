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
import type { EngineConfig } from './types.ts';

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
