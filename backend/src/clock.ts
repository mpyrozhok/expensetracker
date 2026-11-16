import type { Period } from './types.js';

/**
 * The app's only reading of "this month". Budget alerts are calculated for the
 * current calendar month and no other, so every place that has to decide
 * whether a period is alertable goes through here rather than comparing dates
 * by hand.
 */
export function currentPeriod(now = new Date()): Period {
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

/** Whether `period` is the month alerts are calculated for. */
export function isCurrentPeriod(period: Period, now = new Date()): boolean {
  const nowPeriod = currentPeriod(now);
  return period.year === nowPeriod.year && period.month === nowPeriod.month;
}
