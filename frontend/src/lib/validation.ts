import type { TransactionDraft } from './types.js';

export type FieldErrors = Record<string, string>;

const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Client-side mirror of the backend's transaction rules, so a mistake is
 * reported as the user types instead of after a round trip. The backend remains
 * authoritative — the server re-validates everything and returns the same codes.
 */
export function validateAmount(raw: string): string | null {
  const text = raw.trim();
  if (text === '') return 'Amount is required';
  if (!AMOUNT_PATTERN.test(text)) return 'Use a positive number with at most 2 decimals';
  if (!(Number(text) > 0)) return 'Amount must be greater than 0';
  return null;
}

export function validateTitle(raw: string): string | null {
  const text = raw.trim();
  if (text === '') return 'Title is required';
  if (text.length > 200) return 'Title must be 200 characters or fewer';
  return null;
}

export function validateDate(raw: string): string | null {
  const text = raw.trim();
  if (text === '') return 'Date is required';
  if (!DATE_PATTERN.test(text)) return 'Use the YYYY-MM-DD format';
  const parts = text.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  const isReal =
    parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
  if (!isReal) return 'That date does not exist';
  return null;
}

export function validateCategoryId(raw: string): string | null {
  const text = raw.trim();
  if (text === '') return 'Choose a category';
  if (!Number.isInteger(Number(text))) return 'Choose a category';
  return null;
}

export function validateNotes(raw: string): string | null {
  if (raw.length > 2000) return 'Notes must be 2000 characters or fewer';
  return null;
}

export function validateTransaction(draft: TransactionDraft): FieldErrors {
  const checks: Array<[string, string | null]> = [
    ['title', validateTitle(draft.title)],
    ['amount', validateAmount(draft.amount)],
    ['date', validateDate(draft.date)],
    ['category_id', validateCategoryId(draft.category_id)],
    ['notes', validateNotes(draft.notes)],
  ];
  const errors: FieldErrors = {};
  for (const [field, message] of checks) {
    if (message) errors[field] = message;
  }
  return errors;
}

export function validateCategoryName(raw: string): string | null {
  const text = raw.trim();
  if (text === '') return 'Category name is required';
  if (text.length > 60) return 'Category name must be 60 characters or fewer';
  return null;
}

/** A budget must be a positive amount; clearing a budget is a separate action. */
export function validateBudgetAmount(raw: string): string | null {
  const text = raw.trim();
  if (text === '') return 'Enter the amount for the month, or clear the budget instead';
  if (!AMOUNT_PATTERN.test(text)) return 'Use a positive number with at most 2 decimals';
  if (!(Number(text) > 0)) return 'Budget must be greater than 0';
  return null;
}

export function isDirty(draft: TransactionDraft, original: TransactionDraft): boolean {
  const keys = Object.keys(draft) as Array<keyof TransactionDraft>;
  return keys.some((key) => draft[key] !== original[key]);
}
