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

/**
 * Which dates the list shows, and therefore who owns the From/To fields.
 *
 * `period` follows the selected month, so the overview and the list cannot
 * disagree. `custom` is an explicit range typed below. The brief asks for this
 * month / last month / custom range as three choices: the first two are
 * shortcuts that move the selected month and land back on `period`, which is
 * what stops "this month" from meaning "whatever month happens to be selected"
 * — the button that used to mean that was labelled "This month".
 */
export type DateRangeMode = 'period' | 'custom';

export interface TransactionQuery {
  q: string;
  category_ids: number[];
  range: DateRangeMode;
  from: string | null;
  to: string | null;
  min: string;
  max: string;
  sort: string;
}

export const EMPTY_QUERY: TransactionQuery = {
  q: '',
  category_ids: [],
  range: 'period',
  from: null,
  to: null,
  min: '',
  max: '',
  sort: 'date_desc',
};
