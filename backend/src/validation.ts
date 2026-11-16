/** Error carrying an HTTP status and a machine-readable code for the UI. */
export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new ApiError(code, message, 400, details);
export const unauthorized = (message = 'Authentication required') =>
  new ApiError('unauthorized', message, 401);
export const forbidden = (message = 'Not allowed') => new ApiError('forbidden', message, 403);
export const notFound = (message = 'Not found') => new ApiError('not_found', message, 404);
export const conflict = (code: string, message: string, details?: unknown) =>
  new ApiError(code, message, 409, details);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new ApiError(code, message, 422, details);

/**
 * Narrows a row the caller just wrote and read back. A missing row here is an
 * internal invariant violation, never bad user input, so it is a plain Error.
 */
export function assertPresent<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

/**
 * Input validators. They deliberately coerce-then-promise rather than doing
 * structural type checks: a client sending the wrong JSON type must get a 400
 * with a clear message, never a TypeError and never a 500.
 */

export function reqText(value: string | undefined, field: string, max = 200): string {
  const value$ = String(value ?? '').trim();
  if (value$.length === 0) throw badRequest('field_required', `${field} is required`);
  if (value$.length > max) {
    throw badRequest('field_too_long', `${field} must be at most ${max} characters`);
  }
  return value$;
}

export function optText(value: string | undefined, field: string, max = 2000): string {
  const value$ = String(value ?? '').trim();
  if (value$.length > max) {
    throw badRequest('field_too_long', `${field} must be at most ${max} characters`);
  }
  return value$;
}

/** Accepts 12.34, "12.34", 12 → 1234 cents. Rejects 0, negatives, >2 decimals, NaN. */
export function reqAmountCents(value: string | number | undefined, field: string): number {
  const text = String(value ?? '').trim();
  if (text === '') throw badRequest('amount_required', `${field} is required`);
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw badRequest('amount_invalid', `${field} must be a positive amount with at most 2 decimals`);
  }
  const cents = Math.round(Number(text) * 100);
  if (!Number.isFinite(cents) || cents <= 0) {
    throw badRequest('amount_not_positive', `${field} must be greater than 0`);
  }
  if (cents > 100_000_000_00) {
    throw badRequest('amount_too_large', `${field} is too large (max 100000000)`);
  }
  return cents;
}

/** Optional amount: empty/absent → null (used to mean "no amount set"). */
export function optAmountCents(value: string | number | undefined, field: string): number | null {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  if (text === '0' || text === '0.00') return 0;
  return reqAmountCents(text, field);
}

export function reqCurrency(value: string | undefined, supported: readonly string[]): string {
  const code = String(value ?? 'USD').trim().toUpperCase();
  if (!supported.includes(code)) {
    throw badRequest('currency_unsupported', `Unsupported currency "${code}". Supported: ${supported.join(', ')}`);
  }
  return code;
}

/** Validates a YYYY-MM-DD calendar date; rejects 2024-02-31, "not a date", future typos. */
export function reqDate(value: string | undefined, field = 'date'): string {
  const text = String(value ?? '').trim();
  if (text === '') throw badRequest('date_required', `${field} is required`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw badRequest('date_invalid', `${field} must use the YYYY-MM-DD format`);
  }
  const parts = text.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (![year, month, day].every(Number.isInteger)) {
    throw badRequest('date_invalid', `${field} is not a valid calendar date`);
  }
  const parsed = new Date(Date.UTC(year, month - 1, day));
  const isReal =
    parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
  if (!isReal || year < 1900 || year > 2200) {
    throw badRequest('date_invalid', `${field} is not a valid calendar date`);
  }
  return text;
}

export function reqId(value: string | number | undefined, field: string): number {
  const n = Number(String(value ?? '').trim());
  if (!Number.isInteger(n) || n <= 0) {
    throw badRequest('id_invalid', `${field} must be a positive integer`);
  }
  return n;
}

/** category_id may be null/absent → null (Uncategorized). */
export function nullableId(value: string | number | null | undefined, field: string): number | null {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  return reqId(text, field);
}

export function reqPeriod(year: string | undefined, month: string | undefined): { year: number; month: number } {
  const y = Number(String(year ?? '').trim());
  const m = Number(String(month ?? '').trim());
  if (!Number.isInteger(y) || y < 1970 || y > 2200) {
    throw badRequest('period_invalid', 'year must be a valid year');
  }
  if (!Number.isInteger(m) || m < 1 || m > 12) {
    throw badRequest('period_invalid', 'month must be between 1 and 12');
  }
  return { year: y, month: m };
}

export function optNumber(value: string | undefined, field: string): number | undefined {
  const text = String(value ?? '').trim();
  if (text === '') return undefined;
  const n = Number(text);
  if (!Number.isFinite(n)) throw badRequest('field_invalid', `${field} must be a number`);
  return n;
}

export function optEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  field: string,
): T | undefined {
  const text = String(value ?? '').trim();
  if (text === '') return undefined;
  const hit = allowed.find((a) => a === text);
  if (!hit) throw badRequest('field_invalid', `${field} must be one of: ${allowed.join(', ')}`);
  return hit;
}
