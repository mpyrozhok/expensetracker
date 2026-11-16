import type { Db, BudgetRow } from '../db.js';
import { CURRENCIES, type ApiBudget, type ApiSummary, type Currency, type Period } from '../types.js';
import { ApiError, reqCurrency } from '../validation.js';
import { spentForPeriod } from './sql.js';
import { round2 } from './transactions.js';

const SELECT_BUDGET = 'SELECT * FROM budgets WHERE user_id = ? AND year = ? AND month = ?';

const UPSERT_BUDGET = `INSERT INTO budgets (user_id, year, month, amount_cents, currency)
 VALUES (?, ?, ?, ?, ?)
 ON CONFLICT (user_id, year, month)
 DO UPDATE SET amount_cents = excluded.amount_cents, currency = excluded.currency,
               updated_at = datetime('now')`;

const DELETE_BUDGET = 'DELETE FROM budgets WHERE user_id = ? AND year = ? AND month = ?';

/**
 * A budget row is always created through setBudget(), which rejects a missing
 * or non-positive amount, so amount_cents is a positive integer by construction.
 */
function assertAmount(amountCents: number): void {
  if (!(Number.isInteger(amountCents) && amountCents > 0)) {
    throw new ApiError('budget_amount_invalid', 'Budget amount must be greater than 0', 400);
  }
}

export class BudgetsService {
  constructor(private readonly db: Db) {}

  get(userId: number, period: Period): BudgetRow | null {
    const row = this.db.prepare(SELECT_BUDGET).get(userId, period.year, period.month) as BudgetRow | undefined;
    return row ?? null;
  }

  set(userId: number, period: Period, amountCents: number, currency: string): ApiBudget {
    assertAmount(amountCents);
    const code = reqCurrency(currency, CURRENCIES);
    this.db.prepare(UPSERT_BUDGET).run(userId, period.year, period.month, amountCents, code);
    return { year: period.year, month: period.month, amount: amountCents / 100, currency: code as Currency };
  }

  remove(userId: number, period: Period): void {
    this.db.prepare(DELETE_BUDGET).run(userId, period.year, period.month);
  }

  summary(userId: number, period: Period): ApiSummary {
    const budget = this.get(userId, period);
    const spent = spentForPeriod(this.db, userId, period);
    const spentAmount = spent.spent_cents / 100;
    const budgetAmount = budget ? budget.amount_cents / 100 : null;
    return {
      period,
      budget: budget
        ? {
            year: budget.year,
            month: budget.month,
            amount: round2(budget.amount_cents / 100),
            currency: budget.currency as Currency,
          }
        : null,
      spent: spentAmount,
      currency: (budget?.currency ?? 'USD') as Currency,
      remaining: budgetAmount === null ? null : round2(budgetAmount - spentAmount),
      usage_percent:
        budgetAmount === null || budgetAmount === 0 ? null : round2((spentAmount / budgetAmount) * 100),
      transaction_count: spent.transaction_count,
    };
  }
}

export function toApiBudget(row: BudgetRow | null, period: Period): ApiBudget | null {
  if (!row) return null;
  return {
    year: row.year ?? period.year,
    month: row.month ?? period.month,
    amount: row.amount_cents / 100,
    currency: row.currency as Currency,
  };
}
