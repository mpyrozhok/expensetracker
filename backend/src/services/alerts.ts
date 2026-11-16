import type { Db } from '../db.js';
import { BUDGET_ALERT_THRESHOLDS, type ApiAlert, type Currency, type Period } from '../types.js';
import { spentForPeriod } from './sql.js';
import { round2 } from './transactions.js';

/**
 * Budget threshold alerts.
 *
 * Rules (see README):
 *  - evaluated for one calendar month (the period the client subscribes to, and
 *    always the current calendar month for the automatic pushes);
 *  - a threshold alert fires at most once per user + period + threshold; the
 *    ledger is the `budget_alert_fires` table, so a restart or a reconnect does
 *    not re-alert, and editing transactions afterwards cannot spam;
 *  - no budget set for the period => no alerts at all.
 */

export interface BudgetRowLite {
  amount_cents: number;
  currency: string;
}

export interface Evaluation {
  period: Period;
  budget_cents: number;
  spent_cents: number;
  currency: Currency;
  /** Thresholds reached, ascending, including ones fired before. */
  reached: number[];
  /** Thresholds first reached by this evaluation (new rows in the ledger). */
  fresh: number[];
}

const SELECT_BUDGET = 'SELECT amount_cents, currency FROM budgets WHERE user_id = ? AND year = ? AND month = ?';

const INSERT_FIRE = 'INSERT OR IGNORE INTO budget_alert_fires (user_id, year, month, threshold) VALUES (?, ?, ?, ?)';

const SELECT_FIRED = 'SELECT threshold FROM budget_alert_fires WHERE user_id = ? AND year = ? AND month = ? ORDER BY threshold';

const SELECT_FIRES =
  'SELECT threshold, fired_at, read_at FROM budget_alert_fires WHERE user_id = ? AND year = ? AND month = ?';

/**
 * Acknowledgement, written to the ledger. `read_at IS NULL` keeps it idempotent,
 * so repeated acks (two tabs, a retry) cannot move the timestamp.
 */
const MARK_READ =
  `UPDATE budget_alert_fires
      SET read_at = datetime('now')
    WHERE user_id = ? AND year = ? AND month = ? AND threshold = ? AND read_at IS NULL`;

interface FireRow {
  threshold: number;
  fired_at: string;
  read_at: string | null;
}

function firesByThreshold(rows: FireRow[]): Map<number, FireRow> {
  return new Map(rows.map((row) => [row.threshold, row]));
}

export function reachedThresholds(budgetCents: number, spentCents: number): number[] {
  if (!(budgetCents > 0)) return [];
  return BUDGET_ALERT_THRESHOLDS.filter((threshold) => spentCents * 100 >= budgetCents * threshold);
}

export class AlertService {
  constructor(private readonly db: Db) {}

  /**
   * Records any threshold crossed for the period that has not fired yet and
   * returns the full picture. Callers push `fresh` alerts only, so the
   * "once per threshold per month" rule holds across connections and restarts.
   */
  evaluate(userId: number, period: Period): Evaluation | null {
    const budget = this.db.prepare(SELECT_BUDGET).get(userId, period.year, period.month) as
      | BudgetRowLite
      | undefined;
    if (!budget) return null;

    const spent = spentForPeriod(this.db, userId, period);
    const reached = reachedThresholds(budget.amount_cents, spent.spent_cents);
    const fresh: number[] = [];
    for (const threshold of reached) {
      const info = this.db.prepare(INSERT_FIRE).run(userId, period.year, period.month, threshold);
      if (info.changes > 0) fresh.push(threshold);
    }
    return {
      period,
      budget_cents: budget.amount_cents,
      spent_cents: spent.spent_cents,
      currency: budget.currency as Currency,
      reached,
      fresh,
    };
  }

  /** Alerts for a period without writing to the ledger (used to replay state on (re)subscribe). */
  snapshot(userId: number, period: Period): ApiAlert[] {
    const budget = this.db.prepare(SELECT_BUDGET).get(userId, period.year, period.month) as
      | BudgetRowLite
      | undefined;
    if (!budget) return [];
    const fired = firesByThreshold(
      this.db.prepare(SELECT_FIRES).all(userId, period.year, period.month) as FireRow[],
    );

    const spent = spentForPeriod(this.db, userId, period);
    return reachedThresholds(budget.amount_cents, spent.spent_cents).map((threshold) =>
      buildAlert({
        userId,
        period,
        threshold,
        budgetCents: budget.amount_cents,
        spentCents: spent.spent_cents,
        currency: budget.currency as Currency,
        firedAt: fired.get(threshold)?.fired_at ?? '',
        readAt: fired.get(threshold)?.read_at ?? null,
        fresh: false,
      }),
    );
  }

  /**
   * Alerts already in the ledger for a period, without evaluating or firing
   * anything. Used when a socket subscribes to a period the app does not
   * calculate alerts for: the spec keeps threshold alerts to the current
   * calendar month, so viewing last month may show what was recorded while it
   * was current, but must never record something new now that we are looking.
   */
  recorded(userId: number, period: Period): ApiAlert[] {
    const budget = this.db.prepare(SELECT_BUDGET).get(userId, period.year, period.month) as
      | BudgetRowLite
      | undefined;
    if (!budget) return [];
    const rows = this.db.prepare(SELECT_FIRES).all(userId, period.year, period.month) as FireRow[];
    const spent = spentForPeriod(this.db, userId, period);
    return rows
      .sort((a, b) => a.threshold - b.threshold)
      .map((row) =>
        buildAlert({
          userId,
          period,
          threshold: row.threshold,
          budgetCents: budget.amount_cents,
          spentCents: spent.spent_cents,
          currency: budget.currency as Currency,
          firedAt: row.fired_at,
          readAt: row.read_at,
          fresh: false,
        }),
      );
  }

  /**
   * Records that the user acknowledged a threshold alert. Returns false when the
   * threshold has not fired for that user and period, so a forged ack cannot
   * write anything that is not already in the ledger.
   */
  markRead(userId: number, period: Period, threshold: number): boolean {
    const info = this.db.prepare(MARK_READ).run(userId, period.year, period.month, threshold);
    return info.changes > 0;
  }

  firedThresholds(userId: number, period: Period): number[] {
    const rows = this.db.prepare(SELECT_FIRED).all(userId, period.year, period.month) as { threshold: number }[];
    return rows.map((r) => r.threshold);
  }

  toAlerts(userId: number, evaluation: Evaluation): ApiAlert[] {
    const times = firesByThreshold(
      this.db.prepare(SELECT_FIRES).all(userId, evaluation.period.year, evaluation.period.month) as FireRow[],
    );

    return evaluation.reached.map((threshold) =>
      buildAlert({
        userId,
        period: evaluation.period,
        threshold,
        budgetCents: evaluation.budget_cents,
        spentCents: evaluation.spent_cents,
        currency: evaluation.currency,
        firedAt: times.get(threshold)?.fired_at ?? '',
        readAt: times.get(threshold)?.read_at ?? null,
        fresh: evaluation.fresh.includes(threshold),
      }),
    );
  }
}

interface AlertArgs {
  userId: number;
  period: Period;
  threshold: number;
  budgetCents: number;
  spentCents: number;
  currency: Currency;
  firedAt: string;
  readAt: string | null;
  fresh: boolean;
}

function buildAlert(args: AlertArgs): ApiAlert {
  const budget = args.budgetCents / 100;
  const spent = args.spentCents / 100;
  return {
    id: alertId(args.userId, args.period, args.threshold),
    kind: 'budget-alert',
    period: args.period,
    threshold: args.threshold,
    budget,
    spent,
    usage_percent: budget > 0 ? round2((spent / budget) * 100) : 0,
    currency: args.currency,
    fired_at: args.firedAt,
    new: args.fresh,
    read: args.readAt !== null,
  };
}

export function alertId(userId: number, period: Period, threshold: number): string {
  return `ba:${userId}:${period.year}-${period.month}:${threshold}`;
}
