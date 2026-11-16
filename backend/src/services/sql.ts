import type { Db } from '../db.js';
import type { Currency, Period } from '../types.js';

/**
 * Query layer. Every statement is a static string with bound parameters only —
 * no SQL text is ever composed from request data. Optional filters use the
 * "guard predicate + sentinel" pattern: an inactive filter short-circuits on a
 * bound constant (`@q = ''`, `@categoryCount = 0`, …) so one statement covers
 * every combination. Sorting selects one of four fixed CASE branches by the
 * bound `@sort` key. This keeps the whole surface injection-proof by
 * construction rather than by review.
 */

export type SortKey = 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc';
export const SORT_KEYS: readonly SortKey[] = ['date_desc', 'date_asc', 'amount_desc', 'amount_asc'];
export const DEFAULT_SORT: SortKey = 'date_desc';
export const MAX_CATEGORY_FILTER = 10;

export interface TxFilters {
  q: string;
  categoryIds: number[];
  from: string | null;
  to: string | null;
  minCents: number | null;
  maxCents: number | null;
  sort: SortKey;
  limit: number;
  offset: number;
}

export interface TransactionJoinRow {
  id: number;
  user_id: number;
  category_id: number | null;
  title: string;
  amount_cents: number;
  currency: string;
  date: string;
  notes: string;
  created_at: string;
  updated_at: string;
  category_name: string | null;
}

/** Bound parameter set. All values are primitives; unused slots get inert sentinels. */
export type FilterParams = {
  userId: number;
  q: string;
  categoryCount: number;
  from: string;
  to: string;
  minCents: number;
  maxCents: number;
  sort: string;
  limit: number;
  offset: number;
} & Record<string, number>;

const SPACE_AND = ' AND ';

const CATEGORY_PLACEHOLDERS = Array.from({ length: MAX_CATEGORY_FILTER }, (_, i) => `@category${i}`).join(', ');

const FILTER_PREDICATES = [
  't.user_id = @userId',
  "(@q = '' OR t.title LIKE @q ESCAPE '\\' OR t.notes LIKE @q ESCAPE '\\')",
  `(@categoryCount = 0 OR t.category_id IN (${CATEGORY_PLACEHOLDERS}))`,
  "(@from = '' OR t.date >= @from)",
  "(@to = '' OR t.date <= @to)",
  '(@minCents = 0 OR t.amount_cents >= @minCents)',
  '(@maxCents = 0 OR t.amount_cents <= @maxCents)',
].join(SPACE_AND);

const SELECT_LIST = `SELECT t.*, c.name AS category_name
FROM transactions t
LEFT JOIN categories c ON c.id = t.category_id
WHERE ${FILTER_PREDICATES}
ORDER BY
  CASE WHEN @sort = 'date_desc' THEN t.date END DESC,
  CASE WHEN @sort = 'date_asc' THEN t.date END ASC,
  CASE WHEN @sort = 'amount_desc' THEN t.amount_cents END DESC,
  CASE WHEN @sort = 'amount_asc' THEN t.amount_cents END ASC,
  t.id DESC
LIMIT @limit OFFSET @offset`;

const SELECT_COUNT = `SELECT COUNT(*) AS n FROM transactions t WHERE ${FILTER_PREDICATES}`;

const SELECT_TOTALS = `SELECT COALESCE(SUM(t.amount_cents), 0) AS total_cents, COUNT(*) AS n
FROM transactions t
WHERE ${FILTER_PREDICATES}`;

const SELECT_CATEGORY_TOTALS = `SELECT t.category_id AS category_id, COALESCE(SUM(t.amount_cents), 0) AS total_cents
FROM transactions t
WHERE ${FILTER_PREDICATES}
GROUP BY t.category_id`;

export function bindFilters(userId: number, f: TxFilters): FilterParams {
  const params: Record<string, string | number> = {
    userId,
    q: f.q === '' ? '' : `%${escapeLike(f.q)}%`,
    categoryCount: 0,
    from: f.from ?? '',
    to: f.to ?? '',
    minCents: f.minCents ?? 0,
    maxCents: f.maxCents ?? 0,
    sort: f.sort,
    limit: f.limit,
    offset: f.offset,
  };
  const ids = f.categoryIds.slice(0, MAX_CATEGORY_FILTER);
  ids.forEach((id, i) => {
    params[`category${i}`] = id;
  });
  for (let i = ids.length; i < MAX_CATEGORY_FILTER; i += 1) {
    // 0 is never a valid rowid, so unused placeholders can never match a row.
    params[`category${i}`] = 0;
  }
  params.categoryCount = ids.length;
  return params as FilterParams;
}

export function selectTransactions(db: Db, params: FilterParams): TransactionJoinRow[] {
  return db.prepare(SELECT_LIST).all(params) as TransactionJoinRow[];
}

export function countTransactions(db: Db, params: FilterParams): number {
  const row = db.prepare(SELECT_COUNT).get(params) as { n: number };
  return row.n;
}

export function totalsForFilters(
  db: Db,
  params: FilterParams,
): { total_cents: number; n: number } {
  return db.prepare(SELECT_TOTALS).get(params) as { total_cents: number; n: number };
}

export function totalsByCategory(db: Db, params: FilterParams): { category_id: number | null; total_cents: number }[] {
  return db.prepare(SELECT_CATEGORY_TOTALS).all(params) as { category_id: number | null; total_cents: number }[];
}

const SELECT_BY_ID = `SELECT t.*, c.name AS category_name
FROM transactions t
LEFT JOIN categories c ON c.id = t.category_id
WHERE t.user_id = ? AND t.id = ?`;

export function selectTransactionById(db: Db, userId: number, id: number): TransactionJoinRow | undefined {
  return db.prepare(SELECT_BY_ID).get(userId, id) as TransactionJoinRow | undefined;
}

export interface PeriodSpend {
  spent_cents: number;
  transaction_count: number;
}

const SELECT_PERIOD_SPEND = `SELECT COALESCE(SUM(amount_cents), 0) AS spent_cents, COUNT(*) AS transaction_count
FROM transactions
WHERE user_id = ? AND strftime('%Y', date) = ? AND strftime('%m', date) = ?`;

export function spentForPeriod(db: Db, userId: number, period: Period): PeriodSpend {
  return db.prepare(SELECT_PERIOD_SPEND).get(
    userId,
    String(period.year),
    String(period.month).padStart(2, '0'),
  ) as PeriodSpend;
}

export interface CategoryCountRow {
  id: number;
  user_id: number;
  name: string;
  name_ci: string;
  created_at: string;
  transaction_count: number;
}

const SELECT_CATEGORIES = `SELECT c.*, (SELECT COUNT(*) FROM transactions t WHERE t.category_id = c.id) AS transaction_count
FROM categories c
WHERE c.user_id = ?
ORDER BY lower(c.name) COLLATE NOCASE ASC`;

const SELECT_CATEGORY_BY_ID = `SELECT c.*, (SELECT COUNT(*) FROM transactions t WHERE t.category_id = c.id) AS transaction_count
FROM categories c
WHERE c.user_id = ? AND c.id = ?`;

export function selectCategories(db: Db, userId: number): CategoryCountRow[] {
  return db.prepare(SELECT_CATEGORIES).all(userId) as CategoryCountRow[];
}

export function selectCategoryById(db: Db, userId: number, id: number): CategoryCountRow | undefined {
  return db.prepare(SELECT_CATEGORY_BY_ID).get(userId, id) as CategoryCountRow | undefined;
}

export function currencyOr(row: TransactionJoinRow | undefined, fallback: Currency): Currency {
  return row ? (row.currency as Currency) : fallback;
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}
