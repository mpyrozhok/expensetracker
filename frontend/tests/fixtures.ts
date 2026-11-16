import type { ApiAlert, ApiCategory, ApiSummary, ApiTransaction, ApiUser } from '../src/lib/types.js';

export const user: ApiUser = {
  id: 1,
  provider: 'google',
  email: 'ada@example.com',
  display_name: 'Ada Lovelace',
  avatar_url: null,
  created_at: '2026-01-01 10:00:00',
};

export function category(overrides: Partial<ApiCategory> = {}): ApiCategory {
  return {
    id: 10,
    name: 'Groceries',
    transaction_count: 0,
    created_at: '2026-01-01 10:00:00',
    ...overrides,
  };
}

export function transaction(overrides: Partial<ApiTransaction> = {}): ApiTransaction {
  return {
    id: 100,
    title: 'Weekly shop',
    amount: 84.2,
    currency: 'USD',
    date: '2026-03-04',
    category_id: 10,
    category_name: 'Groceries',
    notes: '',
    created_at: '2026-03-04 09:00:00',
    updated_at: '2026-03-04 09:00:00',
    ...overrides,
  };
}

export function summary(overrides: Partial<ApiSummary> = {}): ApiSummary {
  return {
    period: { year: 2026, month: 3 },
    budget: { year: 2026, month: 3, amount: 1000, currency: 'USD' },
    spent: 250,
    currency: 'USD',
    remaining: 750,
    usage_percent: 25,
    transaction_count: 4,
    ...overrides,
  };
}

export function alert(overrides: Partial<ApiAlert> = {}): ApiAlert {
  const base: ApiAlert = {
    id: 'budget-alert:2026-3:50',
    kind: 'budget-alert',
    period: { year: 2026, month: 3 },
    threshold: 50,
    budget: 1000,
    spent: 500,
    usage_percent: 50,
    currency: 'USD',
    fired_at: '2026-03-10T12:00:00.000Z',
    new: true,
    read: false,
  };
  const merged = { ...base, ...overrides };
  return {
    ...merged,
    // Ids are derived from the ledger key, so overriding a threshold never
    // silently produces two alerts with the same identity.
    id: overrides.id ?? `budget-alert:${String(merged.period.year)}-${String(merged.period.month)}:${String(merged.threshold)}`,
  };
}

export const emptyPage = { items: [], total: 0, total_amount: 0, by_category: [] };
