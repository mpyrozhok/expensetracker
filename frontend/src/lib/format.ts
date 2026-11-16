import type { Period } from './types.js';

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

export function formatDay(isoDate: string): string {
  const parts = isoDate.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (![year, month, day].every(Number.isFinite)) return isoDate;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
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
