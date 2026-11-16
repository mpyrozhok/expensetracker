import { describe, expect, it } from 'vitest';
import {
  isDirty,
  validateAmount,
  validateBudgetAmount,
  validateCategoryId,
  validateCategoryName,
  validateDate,
  validateNotes,
  validateTitle,
  validateTransaction,
} from '../src/lib/validation.js';
import type { TransactionDraft } from '../src/lib/types.js';

const draft: TransactionDraft = {
  title: 'Coffee',
  amount: '4.50',
  currency: 'USD',
  date: '2026-03-04',
  category_id: '10',
  notes: '',
};

describe('validateAmount', () => {
  it.each(['1', '1.5', '1.50', '0.01', '123456.99'])('accepts %s', (value) => {
    expect(validateAmount(value)).toBeNull();
  });

  it.each([
    ['', 'required'],
    ['-', 'positive'],
    ['-5', 'positive'],
    ['0', 'greater than 0'],
    ['0.00', 'greater than 0'],
    ['1,000', 'number'],
    ['1.999', 'decimals'],
    ['abc', 'number'],
    ['1e3', 'number'],
  ])('rejects %s with a %s message', (value, fragment) => {
    const message = validateAmount(value);
    expect(message).not.toBeNull();
    expect(message?.toLowerCase()).toContain(fragment);
  });

  it('ignores surrounding spaces', () => {
    expect(validateAmount('  12.30 ')).toBeNull();
  });
});

describe('validateDate', () => {
  it('accepts a real calendar day', () => {
    expect(validateDate('2026-02-28')).toBeNull();
  });

  it('rejects a day that does not exist', () => {
    expect(validateDate('2026-02-30')).toContain('does not exist');
    expect(validateDate('2026-13-01')).toContain('does not exist');
  });

  it('rejects the wrong shape', () => {
    expect(validateDate('2026-3-4')).toContain('YYYY-MM-DD');
    expect(validateDate('')).toContain('required');
  });
});

describe('field validators', () => {
  it('requires a title and caps its length', () => {
    expect(validateTitle('  ')).toContain('required');
    expect(validateTitle('x'.repeat(201))).toContain('200');
    expect(validateTitle('Coffee')).toBeNull();
  });

  it('requires an existing category id', () => {
    expect(validateCategoryId('')).toContain('category');
    expect(validateCategoryId('abc')).toContain('category');
    expect(validateCategoryId('12.5')).toContain('category');
    expect(validateCategoryId('12')).toBeNull();
  });

  it('bounds notes without requiring them', () => {
    expect(validateNotes('')).toBeNull();
    expect(validateNotes('x'.repeat(2001))).toContain('2000');
  });

  it('requires a non-empty unique-style category name', () => {
    expect(validateCategoryName('')).toContain('required');
    expect(validateCategoryName('   ')).toContain('required');
    expect(validateCategoryName('x'.repeat(61))).toContain('60');
    expect(validateCategoryName('Groceries')).toBeNull();
  });
});

describe('validateTransaction', () => {
  it('returns no errors for a valid draft', () => {
    expect(validateTransaction(draft)).toEqual({});
  });

  it('reports every invalid field at once, keyed for the form', () => {
    const errors = validateTransaction({
      ...draft,
      title: '',
      amount: '-2',
      date: 'nope',
      category_id: '',
      notes: 'x'.repeat(3000),
    });
    expect(Object.keys(errors).sort()).toEqual(['amount', 'category_id', 'date', 'notes', 'title']);
  });
});

describe('validateBudgetAmount', () => {
  it('asks for an amount rather than accepting an empty one', () => {
    expect(validateBudgetAmount('')).toContain('clear the budget');
    expect(validateBudgetAmount('0')).toContain('greater than 0');
    expect(validateBudgetAmount('1000')).toBeNull();
  });
});

describe('isDirty', () => {
  it('detects a single changed field', () => {
    expect(isDirty(draft, draft)).toBe(false);
    expect(isDirty({ ...draft, amount: '4.51' }, draft)).toBe(true);
  });
});
