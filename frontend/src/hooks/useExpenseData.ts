import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { resolveDateRange } from '../lib/format.js';
import type { ApiCategory, ApiSummary, ApiTransaction, Period, TransactionQuery } from '../lib/types.js';
import { EMPTY_QUERY } from '../lib/types.js';

const PAGE_SIZE = 10;

/**
 * One-shot loader with cancellation.
 *
 * `revision` is bumped to refetch (month change, mutation, retry). Ignoring the
 * response of a superseded request is what keeps a slow earlier fetch from
 * overwriting a newer one.
 */
function useLoader<T>(revision: string, load: () => Promise<T>): Loader<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
      })
      .catch((thrown: Error) => {
        if (cancelled) return;
        setError(thrown.message === '' ? 'The request failed. Please try again.' : thrown.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  return { data, error, loading };
}

interface Loader<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

function revisionOf(values: Array<string | number>): string {
  return values.join('|');
}

export interface ExpenseData {
  categories: ApiCategory[];
  categoryById: Map<number, ApiCategory>;
  summary: ApiSummary | null;
  transactions: ApiTransaction[];
  filteredTotal: number;
  filteredAmount: number;
  byCategory: { category_id: number | null; total: number }[];
  page: number;
  pageCount: number;
  query: TransactionQuery;
  loadingSummary: boolean;
  loadingTransactions: boolean;
  loadingCategories: boolean;
  summaryError: string | null;
  transactionsError: string | null;
  categoriesError: string | null;
  setQuery: (next: TransactionQuery) => void;
  setPage: (page: number) => void;
  refreshAll: () => void;
  createTransaction: (draft: Payload) => Promise<ApiTransaction>;
  updateTransaction: (id: number, draft: Payload) => Promise<ApiTransaction>;
  deleteTransaction: (id: number) => Promise<void>;
  createCategory: (name: string) => Promise<ApiCategory>;
  renameCategory: (id: number, name: string) => Promise<ApiCategory>;
  deleteCategory: (id: number) => Promise<void>;
  saveBudget: (amount: string) => Promise<void>;
  clearBudget: () => Promise<void>;
}

export type Payload = Record<string, string | number | null>;

export interface TransactionPage {
  items: ApiTransaction[];
  total: number;
  total_amount: number;
  by_category: { category_id: number | null; total: number }[];
}

/**
 * Every piece of expense data for the selected month, refetched after each
 * mutation. Refetching instead of patching local state keeps the server the
 * single authority, so totals, pagination and alert evaluation can never drift
 * from what was actually stored.
 */
export function useExpenseData(period: Period): ExpenseData {
  const [nonce, setNonce] = useState(0);
  const [page, setPageState] = useState(1);
  const [query, setQueryState] = useState<TransactionQuery>(EMPTY_QUERY);

  const refreshAll = useCallback(() => setNonce((value) => value + 1), []);

  const monthRevision = revisionOf([period.year, period.month, nonce]);
  const categoriesLoader = useLoader(revisionOf([nonce]), () => api.categories.list());
  const summaryLoader = useLoader(monthRevision, () => api.budgets.summary(period));

  /** Selected month plus active filters, translated into API parameters. */
  const listParams = useMemo(() => {
    // Whichever of the selected month or a typed range wins is decided in one
    // place, shared with the label the list prints beside its totals.
    const range = resolveDateRange(period, query);
    return {
      q: query.q,
      category_ids: query.category_ids.map(String),
      from: range.from,
      to: range.to,
      min: query.min,
      max: query.max,
      sort: query.sort,
      // The list endpoint pages with limit/offset; the range above is inclusive,
      // so paging and range selection compose.
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    };
  }, [period.year, period.month, query, page]);

  const pageRevision = revisionOf([
    monthRevision,
    listParams.from,
    listParams.to,
    listParams.q,
    listParams.min,
    listParams.max,
    listParams.sort,
    listParams.offset,
    ...listParams.category_ids,
  ]);
  const pageLoader = useLoader<TransactionPage>(pageRevision, () => api.transactions.list(listParams));

  const categories = categoriesLoader.data?.items ?? [];
  const summary = summaryLoader.data;
  const rows = pageLoader.data?.items ?? [];
  const filteredTotal = pageLoader.data?.total ?? 0;

  const setQuery = useCallback((next: TransactionQuery) => {
    setQueryState(next);
    setPageState(1);
  }, []);

  const setPage = useCallback((next: number) => {
    setPageState(Math.max(1, next));
  }, []);

  const createTransaction = useCallback(
    async (draft: Payload) => {
      const result = await api.transactions.create(draft);
      refreshAll();
      return result.item;
    },
    [refreshAll],
  );

  const updateTransaction = useCallback(
    async (id: number, draft: Payload) => {
      const result = await api.transactions.update(id, draft);
      refreshAll();
      return result.item;
    },
    [refreshAll],
  );

  const deleteTransaction = useCallback(
    async (id: number) => {
      await api.transactions.remove(id);
      refreshAll();
    },
    [refreshAll],
  );

  const createCategory = useCallback(
    async (name: string) => {
      const result = await api.categories.create(name);
      refreshAll();
      return result.item;
    },
    [refreshAll],
  );

  const renameCategory = useCallback(
    async (id: number, name: string) => {
      const result = await api.categories.rename(id, name);
      refreshAll();
      return result.item;
    },
    [refreshAll],
  );

  const deleteCategory = useCallback(
    async (id: number) => {
      await api.categories.remove(id);
      refreshAll();
    },
    [refreshAll],
  );

  const saveBudget = useCallback(
    async (amount: string) => {
      await api.budgets.set(period, amount);
      refreshAll();
    },
    [period.year, period.month, refreshAll],
  );

  const clearBudget = useCallback(async () => {
    await api.budgets.remove(period);
    refreshAll();
  }, [period.year, period.month, refreshAll]);

  const categoryById = useMemo(() => new Map(categories.map((category) => [category.id, category])), [categories]);

  return {
    categories,
    categoryById,
    summary,
    transactions: rows,
    filteredTotal,
    filteredAmount: pageLoader.data?.total_amount ?? 0,
    byCategory: pageLoader.data?.by_category ?? [],
    page,
    pageCount: Math.max(1, Math.ceil(filteredTotal / PAGE_SIZE)),
    query,
    loadingSummary: summaryLoader.loading,
    loadingTransactions: pageLoader.loading,
    loadingCategories: categoriesLoader.loading,
    summaryError: summaryLoader.error,
    transactionsError: pageLoader.error,
    categoriesError: categoriesLoader.error,
    setQuery,
    setPage,
    refreshAll,
    createTransaction,
    updateTransaction,
    deleteTransaction,
    createCategory,
    renameCategory,
    deleteCategory,
    saveBudget,
    clearBudget,
  };
}

export { PAGE_SIZE };
