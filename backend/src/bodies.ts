/**
 * Wire shapes for request bodies. Express hands us parsed JSON as untyped
 * values; these interfaces describe the documented contract so the validators
 * receive correctly typed inputs, and every validator additionally coerces and
 * range-checks, so a client sending the wrong JSON type gets a 400 instead of a
 * crash.
 */

export interface CategoryBody {
  name?: string;
}

export interface PeriodQuery {
  year?: string;
  month?: string;
}

export interface TransactionBody {
  title?: string;
  amount?: string | number;
  currency?: string;
  date?: string;
  category_id?: string | number | null;
  notes?: string;
}

export interface BudgetBody {
  year?: string | number;
  month?: string | number;
  amount?: string | number;
  currency?: string;
}

export interface MockLoginBody {
  provider?: string;
  mock_user?: string;
}

export interface QueryString {
  q?: string;
  category_ids?: string;
  from?: string;
  to?: string;
  min?: string;
  max?: string;
  sort?: string;
  limit?: string;
  offset?: string;
  year?: string;
  month?: string;
  provider?: string;
  mock_user?: string;
  /** OAuth2 protocol parameters on the provider callback. */
  state?: string;
  code?: string;
  error?: string;
}
