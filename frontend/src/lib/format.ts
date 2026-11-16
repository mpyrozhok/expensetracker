import type { Period, TransactionQuery } from './types.js';

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const monthNames = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** A single currency for the MVP, made explicit wherever an amount is shown. */
export function formatMoney(amount: number | null, currency = 'USD'): string {
  if (amount === null) return '—';
  return currency === 'USD' ? money.format(amount) : `${amount.toFixed(2)} ${currency}`;
}

export function formatMonth(period: Period): string {
  const name = monthNames[period.month - 1] ?? String(period.month);
  return `${name} ${String(period.year)}`;
}

function formatIso(isoDate: string, options: Intl.DateTimeFormatOptions): string {
  const parts = isoDate.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (![year, month, day].every(Number.isFinite)) return isoDate;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    ...options,
  });
}

export function formatDay(isoDate: string): string {
  return formatIso(isoDate, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * A range phrased once — "Mar 5 – Mar 10, 2026" — with the year twice only when
 * the range really does cross a year. Two full dates side by side read like two
 * unrelated dates.
 */
export function formatDateRange(from: string, to: string): string {
  if (from === to) return formatDay(from);
  if (from.slice(0, 4) === to.slice(0, 4)) {
    return `${formatIso(from, { month: 'short', day: 'numeric' })} – ${formatDay(to)}`;
  }
  return `${formatDay(from)} – ${formatDay(to)}`;
}

export function todayIso(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function currentPeriod(now = new Date()): Period {
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

export function shiftPeriod(period: Period, months: number): Period {
  const zeroBased = period.year * 12 + (period.month - 1) + months;
  return { year: Math.floor(zeroBased / 12), month: (zeroBased % 12) + 1 };
}

export function samePeriod(a: Period, b: Period): boolean {
  return a.year === b.year && a.month === b.month;
}

export function periodLabel(period: Period, now = new Date()): string {
  const label = formatMonth(period);
  const today = currentPeriod(now);
  if (period.year === today.year && period.month === today.month) return `${label} (current)`;
  return label;
}

/** Inclusive first/last calendar day of a period as YYYY-MM-DD. */
export function periodBounds(period: Period): { from: string; to: string } {
  const lastDay = new Date(period.year, period.month, 0).getDate();
  const month = String(period.month).padStart(2, '0');
  return {
    from: `${String(period.year)}-${month}-01`,
    to: `${String(period.year)}-${month}-${String(lastDay).padStart(2, '0')}`,
  };
}

/**
 * The inclusive dates a list should ask for, given how its range was chosen.
 *
 * Exported because the request and the label describing it must agree: this is
 * the only place that knows whether the selected month or a typed From/To wins,
 * so a screen cannot print a range it did not fetch.
 */
export function resolveDateRange(
  period: Period,
  range: Pick<TransactionQuery, 'range' | 'from' | 'to'>,
): { from: string; to: string } {
  const bounds = periodBounds(period);
  if (range.range !== 'custom') return bounds;
  return { from: range.from ?? bounds.from, to: range.to ?? bounds.to };
}

export function initials(name: string): string {
  const words = name.split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return '?';
  const first = words[0]?.charAt(0) ?? '?';
  const second = words.length > 1 ? (words[1]?.charAt(0) ?? '') : '';
  return `${first}${second}`.toUpperCase();
}

export function percent(value: number | null): string {
  if (value === null) return '—';
  return `${Math.round(value)}%`;
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/**
 * Plain-language copy for the OAuth `error` codes a provider sends back when a
 * sign-in does not complete. The provider's own token is never shown verbatim:
 * it arrives in a URL, so it is treated as untrusted input and only ever mapped
 * to a fixed string, with a shape check before any fallback echo.
 */
const AUTH_ERROR_COPY: Record<string, string> = {
  access_denied: 'Sign-in was cancelled. Choose a provider again whenever you are ready.',
  consent_required: 'The provider asked for extra permission that was not granted. Try signing in again.',
  account_selection_cancelled: 'No account was chosen, so signing in stopped.',
  interaction_required: 'The provider needs you to sign in to it first. Try again.',
  login_required: 'You are not signed in at that provider. Sign in there and try again.',
  server_error: 'The provider had an error. Try signing in again in a moment.',
  temporarily_unavailable: 'The provider is unavailable right now. Try again in a moment.',
  invalid_grant: 'That sign-in attempt expired. Start again from the sign-in screen.',
  invalid_scope: 'This deployment asked the provider for an unexpected permission (check the OAuth scopes).',
  unauthorized_client: 'The provider does not recognise this app (check the OAuth client id and redirect URI).',
};

export function describeAuthError(code: string | null): string | null {
  if (code === null) return null;
  const key = code.trim().toLowerCase();
  if (key === '') return null;
  const known = AUTH_ERROR_COPY[key];
  if (known) return known;
  // An unrecognised code still beats a blank screen, but it is only echoed once
  // it has been reduced to a shape that cannot carry markup.
  const safe = /^[a-z0-9_-]{1,40}$/.test(key) ? key : 'unknown';
  return `Sign-in did not complete (${safe}). Try again, or use the other provider.`;
}
