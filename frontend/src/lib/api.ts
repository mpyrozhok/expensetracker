import type { ApiCategory, ApiSummary, ApiTransaction, ApiUser, Period } from './types.js';

export const CSRF_HEADER = 'X-Requested-With';
export const CSRF_HEADER_VALUE = 'expense-tracker';

/** Normalized transport/API failure: the UI always renders `message`. */
export class ApiFailure extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = 'ApiFailure';
    this.code = code;
    this.status = status;
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string };
}

async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { [CSRF_HEADER]: CSRF_HEADER_VALUE };
  if (init.body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      // The session cookie is HttpOnly; same-origin credentials keep it on the
      // wire without ever exposing it to JavaScript.
      credentials: 'same-origin',
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiFailure('network_error', 'Cannot reach the server. Is the backend running?');
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();

  if (!response.ok) {
    const body = parseAs<ErrorBody>(text) ?? {};
    throw new ApiFailure(
      body.error?.code ?? 'request_failed',
      body.error?.message ?? `Request failed with status ${String(response.status)}`,
      response.status,
    );
  }

  const payload = parseAs<T>(text);
  if (payload === null) throw new ApiFailure('invalid_response', 'Server returned an unreadable response');
  return payload;
}

/** JSON boundary: the caller names the expected shape, and malformed input is null, not a crash. */
function parseAs<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export interface TransactionListResponse {
  items: ApiTransaction[];
  total: number;
  total_amount: number;
  by_category: { category_id: number | null; total: number }[];
}

function transactionQuery(params: Record<string, string | number | string[] | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) search.set(key, value.join(','));
      continue;
    }
    const text = String(value);
    if (text !== '') search.set(key, text);
  }
  const query = search.toString();
  return query === '' ? '' : `?${query}`;
}

export const api = {
  me: () => request<{ user: ApiUser }>('/api/auth/me'),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  /** Full-page navigation: the backend answers with a 302 to the provider. */
  beginLogin: (provider: string) => {
    window.location.assign(`/api/auth/${encodeURIComponent(provider)}/login`);
  },
  /** Local evaluation only: signs in through the stub provider (ALLOW_MOCK_AUTH=1). */
  mockLogin: (provider: string, mockUser: string) =>
    request<{ user: ApiUser }>('/api/auth/mock/login', {
      method: 'POST',
      body: { provider, mock_user: mockUser },
    }),
  providers: () =>
    request<{
      providers: { name: string; configured: boolean; authorize_path: string }[];
      mock_auth_enabled: boolean;
    }>('/api/auth/providers'),

  categories: {
    list: () => request<{ items: ApiCategory[] }>('/api/categories'),
    create: (name: string) => request<{ item: ApiCategory }>('/api/categories', { method: 'POST', body: { name } }),
    rename: (id: number, name: string) =>
      request<{ item: ApiCategory }>(`/api/categories/${String(id)}`, { method: 'PUT', body: { name } }),
    remove: (id: number) => request<void>(`/api/categories/${String(id)}`, { method: 'DELETE' }),
  },

  transactions: {
    /** Query keys mirror the backend contract: limit/offset paging, min/max in units. */
    list: (params: Record<string, string | number | string[] | undefined>) =>
      request<TransactionListResponse>(`/api/transactions${transactionQuery(params)}`),
    create: (body: Record<string, unknown>) =>
      request<{ item: ApiTransaction }>('/api/transactions', { method: 'POST', body }),
    update: (id: number, body: Record<string, unknown>) =>
      request<{ item: ApiTransaction }>(`/api/transactions/${String(id)}`, { method: 'PUT', body }),
    remove: (id: number) => request<void>(`/api/transactions/${String(id)}`, { method: 'DELETE' }),
  },

  budgets: {
    summary: (period: Period) =>
      request<ApiSummary>(`/api/budgets/summary${transactionQuery({ year: period.year, month: period.month })}`),
    set: (period: Period, amount: string) =>
      request<{ budget: { amount: number } }>('/api/budgets', {
        method: 'PUT',
        body: { year: period.year, month: period.month, amount, currency: 'USD' },
      }),
    remove: (period: Period) =>
      request<void>(`/api/budgets${transactionQuery({ year: period.year, month: period.month })}`, {
        method: 'DELETE',
      }),
  },
};
