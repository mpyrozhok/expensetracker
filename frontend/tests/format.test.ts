import { describe, expect, it } from 'vitest';
import {
  clampPercent,
  currentPeriod,
  describeAuthError,
  formatDateRange,
  formatDay,
  formatMoney,
  formatMonth,
  percent,
  periodBounds,
  periodLabel,
  resolveDateRange,
  samePeriod,
  shiftPeriod,
  todayIso,
} from '../src/lib/format.js';

describe('formatMoney', () => {
  it('renders USD with two decimals and a thousands separator', () => {
    expect(formatMoney(1234.5)).toBe('$1,234.50');
    expect(formatMoney(0)).toBe('$0.00');
  });

  it('renders negative amounts as a minus sign outside the symbol', () => {
    expect(formatMoney(-52.1)).toBe('-$52.10');
  });

  it('shows a dash when there is nothing to report', () => {
    expect(formatMoney(null)).toBe('—');
  });

  it('falls back to a suffixed amount for a currency without a locale profile', () => {
    expect(formatMoney(10, 'EUR')).toBe('10.00 EUR');
  });
});

describe('formatMonth / formatDay', () => {
  it('spells out the month', () => {
    expect(formatMonth({ year: 2026, month: 3 })).toBe('March 2026');
    expect(formatMonth({ year: 2026, month: 12 })).toBe('December 2026');
  });

  it('formats a calendar date without timezone drift', () => {
    expect(formatDay('2026-03-04')).toBe('Mar 4, 2026');
    expect(formatDay('2026-01-01')).toBe('Jan 1, 2026');
  });

  it('passes through a value it cannot parse', () => {
    expect(formatDay('not-a-date')).toBe('not-a-date');
  });
});

describe('period arithmetic', () => {
  it('shifts across a year boundary in both directions', () => {
    expect(shiftPeriod({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftPeriod({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftPeriod({ year: 2026, month: 6 }, -18)).toEqual({ year: 2024, month: 12 });
  });

  it('returns the inclusive first and last day of the period', () => {
    expect(periodBounds({ year: 2026, month: 2 })).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(periodBounds({ year: 2024, month: 2 })).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(periodBounds({ year: 2026, month: 11 })).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(periodBounds({ year: 2026, month: 12 })).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('derives a zero-padded ISO day from a fixed instant', () => {
    expect(todayIso(new Date(2026, 2, 4))).toBe('2026-03-04');
    expect(currentPeriod(new Date(2026, 2, 4))).toEqual({ year: 2026, month: 3 });
  });

  it('marks only the current month as current in the label', () => {
    const now = new Date(2026, 2, 4);
    expect(periodLabel({ year: 2026, month: 3 }, now)).toBe('March 2026 (current)');
    expect(periodLabel({ year: 2026, month: 2 }, now)).toBe('February 2026');
  });
});

describe('percent', () => {
  it('rounds for display and keeps null distinct from zero', () => {
    expect(percent(33.6)).toBe('34%');
    expect(percent(null)).toBe('—');
  });

  it('clamps into the 0-100 range used by the progress bar', () => {
    expect(clampPercent(-20)).toBe(0);
    expect(clampPercent(140)).toBe(100);
    expect(clampPercent(Number.NaN)).toBe(0);
  });
});

describe('describeAuthError', () => {
  it('says what a cancelled sign-in was', () => {
    expect(describeAuthError('access_denied')).toMatch(/cancelled/i);
    expect(describeAuthError('ACCOUNT_SELECTION_CANCELLED')).toMatch(/No account was chosen/);
  });

  it('stays silent when there was no error', () => {
    expect(describeAuthError(null)).toBeNull();
    expect(describeAuthError('')).toBeNull();
    expect(describeAuthError('   ')).toBeNull();
  });

  it('names an unrecognised code without letting it carry markup', () => {
    expect(describeAuthError('some_new_code')).toBe('Sign-in did not complete (some_new_code). Try again, or use the other provider.');
    // The code arrives in a URL, so it is treated as hostile until proven plain.
    expect(describeAuthError('<img src=x onerror=alert(1)>')).toBe(
      'Sign-in did not complete (unknown). Try again, or use the other provider.',
    );
    expect(describeAuthError('a'.repeat(80))).toBe(
      'Sign-in did not complete (unknown). Try again, or use the other provider.',
    );
  });
});

describe('samePeriod', () => {
  it('compares periods by value, not identity', () => {
    expect(samePeriod({ year: 2026, month: 3 }, { year: 2026, month: 3 })).toBe(true);
    expect(samePeriod({ year: 2026, month: 3 }, { year: 2025, month: 12 })).toBe(false);
  });
});

describe('resolveDateRange', () => {
  const period = { year: 2026, month: 3 };

  it('follows the selected month, ignoring bounds left over from a custom range', () => {
    // Bounds are cleared when a preset is chosen, but a stale pair must never
    // silently win over the month the header shows.
    expect(resolveDateRange(period, { range: 'period', from: '2026-01-05', to: null })).toEqual({
      from: '2026-03-01',
      to: '2026-03-31',
    });
  });

  it('honours a custom range, filling an open end from the selected month', () => {
    expect(resolveDateRange(period, { range: 'custom', from: '2026-03-05', to: null })).toEqual({
      from: '2026-03-05',
      to: '2026-03-31',
    });
  });
});

describe('formatDateRange', () => {
  it('prints the year once while the range stays inside it', () => {
    expect(formatDateRange('2026-03-05', '2026-03-10')).toBe('Mar 5 – Mar 10, 2026');
    expect(formatDateRange('2026-03-05', '2026-03-05')).toBe('Mar 5, 2026');
  });

  it('prints both years when the range crosses a year boundary', () => {
    expect(formatDateRange('2025-12-20', '2026-03-10')).toBe('Dec 20, 2025 – Mar 10, 2026');
  });
});
