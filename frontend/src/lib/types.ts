/**
 * The single source of truth for the wire format is the backend, which is where
 * these types live. They are type-only imports, so Vite erases them and the
 * frontend bundle never references backend code at runtime.
 */
export type {
  ApiUser,
  ApiCategory,
  ApiTransaction,
  ApiBudget,
  ApiSummary,
  ApiAlert,
  ClientMessage,
  ServerMessage,
  Period,
  Currency,
} from '../../../backend/src/types.js';

export const CURRENCY = 'USD';
export const BUDGET_ALERT_THRESHOLDS = [50, 80, 100] as const;

/** A transaction as the form holds it: raw strings, validated before sending. */
export interface TransactionDraft {
  title: string;
  amount: string;
  currency: string;
  date: string;
  category_id: string;
  notes: string;
}

export interface TransactionQuery {
  q: string;
  category_ids: number[];
  from: string | null;
  to: string | null;
  min: string;
  max: string;
  sort: string;
}

export type DateRangePreset = 'all' | 'this_month' | 'last_month' | 'custom';

export const EMPTY_QUERY: TransactionQuery = {
  q: '',
  category_ids: [],
  from: null,
  to: null,
  min: '',
  max: '',
  sort: 'date_desc',
};
