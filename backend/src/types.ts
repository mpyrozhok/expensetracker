export const CURRENCIES = ['USD'] as const;
export type Currency = (typeof CURRENCIES)[number];
export const DEFAULT_CURRENCY: Currency = 'USD';

export const BUDGET_ALERT_THRESHOLDS = [50, 80, 100] as const;
export type BudgetThreshold = (typeof BUDGET_ALERT_THRESHOLDS)[number];

export interface Period {
  year: number;
  month: number;
}

export interface ApiUser {
  id: number;
  provider: string;
  email: string | null;
  display_name: string;
  avatar_url: string | null;
  created_at: string;
}

export interface ApiCategory {
  id: number;
  name: string;
  transaction_count: number;
  created_at: string;
}

export interface ApiTransaction {
  id: number;
  title: string;
  amount: number;
  currency: Currency;
  date: string;
  category_id: number | null;
  category_name: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface ApiBudget {
  year: number;
  month: number;
  amount: number;
  currency: Currency;
}

export interface ApiSummary {
  period: Period;
  budget: ApiBudget | null;
  spent: number;
  currency: Currency;
  remaining: number | null;
  /** null when no budget is set for the period. */
  usage_percent: number | null;
  transaction_count: number;
}

export interface ApiAlert {
  id: string;
  kind: 'budget-alert';
  period: Period;
  threshold: number;
  budget: number;
  spent: number;
  usage_percent: number;
  currency: Currency;
  fired_at: string;
  new: boolean;
  read: boolean;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/* ------------------------------ WebSocket protocol ----------------------------- */

export type ClientMessage =
  | { type: 'subscribe'; channel: 'budget_alerts'; period: Period }
  | { type: 'unsubscribe'; channel: 'budget_alerts' }
  | { type: 'ack'; channel: 'budget_alerts'; period: Period; threshold: number }
  | { type: 'ping' };

export type ServerMessage =
  | { type: 'welcome'; server_time: string; user_id: number }
  | { type: 'subscription'; channel: 'budget_alerts'; period: Period; ok: boolean }
  | { type: 'unsubscribed'; channel: 'budget_alerts' }
  | { type: 'ack'; channel: 'budget_alerts'; period: Period; threshold: number; ok: boolean }
  | { type: 'alert-read'; channel: 'budget_alerts'; period: Period; threshold: number }
  | { type: 'budget-alerts'; period: Period; alerts: ApiAlert[] }
  | { type: 'pong'; server_time: string }
  | { type: 'error'; code: string; message: string };
