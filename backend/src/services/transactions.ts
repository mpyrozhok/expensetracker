import type { Db } from '../db.js';
import type { TransactionBody } from '../bodies.js';
import {
  CURRENCIES,
  type ApiTransaction,
  type ApiSummary,
  type Currency,
  type Period,
} from '../types.js';
import { ApiError, assertPresent, notFound, reqAmountCents, reqCurrency, reqDate, reqId, reqText, optText } from '../validation.js';
import {
  bindFilters,
  countTransactions,
  selectTransactionById,
  selectTransactions,
  spentForPeriod,
  totalsByCategory,
  totalsForFilters,
  type SortKey,
  type TransactionJoinRow,
  type TxFilters,
} from './sql.js';

export interface TransactionInput {
  title: string;
  amount_cents: number;
  currency: Currency;
  date: string;
  category_id: number;
  notes: string;
}

/**
 * Parses a transaction create/update payload into validated values.
 * `partial: true` (PATCH-like) only validates the keys actually present.
 */
export function parseTransactionInput(
  body: TransactionBody,
  opts: { partial: boolean },
): Partial<TransactionInput> {
  const out: Partial<TransactionInput> = {};
  const touched = (field: keyof TransactionBody) => Object.hasOwn(body, field) || !opts.partial;

  if (touched('title')) out.title = reqText(body.title, 'Title', 200);
  if (touched('amount')) out.amount_cents = reqAmountCents(body.amount, 'Amount');
  if (touched('currency')) out.currency = reqCurrency(body.currency, CURRENCIES) as Currency;
  if (touched('date')) out.date = reqDate(body.date, 'Date');
  if (touched('category_id')) out.category_id = reqId(body.category_id ?? undefined, 'Category');
  if (touched('notes')) out.notes = optText(body.notes, 'Notes', 2000);
  return out;
}

export interface TransactionListResult {
  items: ApiTransaction[];
  total: number;
  total_amount: number;
  by_category: { category_id: number | null; total: number }[];
}

const INSERT_TRANSACTION = `INSERT INTO transactions (user_id, category_id, title, amount_cents, currency, date, notes)
 VALUES (@user_id, @category_id, @title, @amount_cents, @currency, @date, @notes)`;

const UPDATE_TRANSACTION = `UPDATE transactions
 SET title = @title, amount_cents = @amount_cents, currency = @currency,
     date = @date, category_id = @category_id, notes = @notes, updated_at = datetime('now')
 WHERE user_id = @user_id AND id = @id`;

const DELETE_TRANSACTION = 'DELETE FROM transactions WHERE user_id = ? AND id = ?';

const SELECT_CATEGORY_OWNER = 'SELECT id FROM categories WHERE user_id = ? AND id = ?';

export class TransactionsService {
  constructor(private readonly db: Db) {}

  list(userId: number, filters: TxFilters): TransactionListResult {
    const params = bindFilters(userId, filters);
    const rows = selectTransactions(this.db, params);
    const total = countTransactions(this.db, params);
    const sums = totalsForFilters(this.db, params);
    const byCategory = totalsByCategory(this.db, params).map((row) => ({
      category_id: row.category_id,
      total: row.total_cents / 100,
    }));
    return {
      items: rows.map(toApiTransaction),
      total,
      total_amount: sums.total_cents / 100,
      by_category: byCategory,
    };
  }

  get(userId: number, id: number): ApiTransaction | null {
    const row = selectTransactionById(this.db, userId, id);
    return row ? toApiTransaction(row) : null;
  }

  create(userId: number, input: TransactionInput): ApiTransaction {
    this.assertCategoryOwned(userId, input.category_id);
    const info = this.db.prepare(INSERT_TRANSACTION).run({ ...input, user_id: userId });
    return assertPresent(this.get(userId, Number(info.lastInsertRowid)), 'transaction vanished after insert');
  }

  update(userId: number, id: number, input: Partial<TransactionInput>): ApiTransaction {
    const existing = this.getOwnedRow(userId, id);
    const next: TransactionInput = {
      title: input.title ?? existing.title,
      amount_cents: input.amount_cents ?? existing.amount_cents,
      currency: (input.currency ?? existing.currency) as Currency,
      date: input.date ?? existing.date,
      category_id: input.category_id ?? (existing.category_id ?? 0),
      notes: input.notes ?? existing.notes,
    };
    if (!(next.amount_cents > 0)) {
      throw new ApiError('amount_not_positive', 'Amount must be greater than 0', 400);
    }
    this.assertCategoryOwned(userId, next.category_id);
    this.db.prepare(UPDATE_TRANSACTION).run({ ...next, user_id: userId, id });
    return assertPresent(this.get(userId, id), 'transaction vanished after update');
  }

  delete(userId: number, id: number): void {
    this.getOwnedRow(userId, id);
    this.db.prepare(DELETE_TRANSACTION).run(userId, id);
  }

  spentForPeriod(userId: number, period: Period): { spent_cents: number; transaction_count: number } {
    return spentForPeriod(this.db, userId, period);
  }

  private getOwnedRow(userId: number, id: number): TransactionJoinRow {
    const row = selectTransactionById(this.db, userId, id);
    if (!row) throw notFound('Transaction not found');
    return row;
  }

  /**
   * Authorization lives here, not only in the route: another user's category id
   * is reported as missing, so ids cannot be probed across accounts.
   */
  private assertCategoryOwned(userId: number, categoryId: number): void {
    const owned = this.db.prepare(SELECT_CATEGORY_OWNER).get(userId, categoryId);
    if (!owned) throw notFound('Category not found');
  }
}

export function toApiTransaction(row: TransactionJoinRow): ApiTransaction {
  return {
    id: row.id,
    title: row.title,
    amount: row.amount_cents / 100,
    currency: row.currency as Currency,
    date: row.date,
    category_id: row.category_id,
    category_name: row.category_name,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;

export function buildSummary(
  period: Period,
  budget: { amount_cents: number; currency: string } | null,
  spent: { spent_cents: number; transaction_count: number },
): ApiSummary {
  const spentAmount = spent.spent_cents / 100;
  const budgetAmount = budget ? budget.amount_cents / 100 : null;
  return {
    period,
    budget: budget
      ? {
          year: period.year,
          month: period.month,
          amount: round2(budgetAmount ?? 0),
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

export const SORT_KEYS: readonly SortKey[] = ['date_desc', 'date_asc', 'amount_desc', 'amount_asc'];
