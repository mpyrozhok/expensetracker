// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Transactions } from '../src/components/Transactions.js';
import { currentPeriod, shiftPeriod } from '../src/lib/format.js';
import type { ApiCategory, ApiTransaction, TransactionQuery } from '../src/lib/types.js';
import { EMPTY_QUERY } from '../src/lib/types.js';
import { category as categoryFixture, transaction as transactionFixture } from './fixtures.js';

const period = { year: 2026, month: 3 };
const categories: ApiCategory[] = [
  categoryFixture({ id: 1, name: 'Groceries' }),
  categoryFixture({ id: 2, name: 'Transport' }),
];

function renderPanel(overrides: Partial<React.ComponentProps<typeof Transactions>> = {}) {
  const props = {
    period,
    categories,
    transactions: [
      transactionFixture({ id: 1, title: 'Weekly shop', amount: 84.2, category_name: 'Groceries' }),
      transactionFixture({ id: 2, title: 'Train ticket', amount: 6.4, date: '2026-03-11', category_name: 'Transport', notes: 'Airport' }),
    ],
    filteredTotal: 2,
    filteredAmount: 90.6,
    monthCount: 2,
    page: 1,
    pageCount: 1,
    query: EMPTY_QUERY,
    loading: false,
    error: null,
    onRetry: vi.fn(),
    onQueryChange: vi.fn(),
    onPeriodChange: vi.fn(),
    onPageChange: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onCreate: vi.fn(),
    ...overrides,
  };
  const view = render(<Transactions {...props} />);
  return { ...view, props };
}

function queryWith(patch: Partial<TransactionQuery>): TransactionQuery {
  return { ...EMPTY_QUERY, ...patch };
}

describe('Transactions', () => {
  it('renders one row per transaction with its date, category and amount', () => {
    renderPanel();

    // The same data is rendered twice on purpose: a table for wide screens and
    // a card list under 720px, with CSS showing exactly one of them.
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(3); // header + 2 rows
    expect(within(table).getByText('Weekly shop')).toBeInTheDocument();
    expect(within(table).getByText('Groceries')).toBeInTheDocument();
    expect(within(table).getByText('$84.20')).toBeInTheDocument();
    expect(within(table).getByText('Mar 4, 2026')).toBeInTheDocument();
  });

  it('shows notes only when a transaction has them', () => {
    renderPanel();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Airport')).toBeInTheDocument();
    expect(within(table).getAllByText('Weekly shop')).toHaveLength(1);
  });

  it('labels the result count and the money currently in view', () => {
    renderPanel();
    expect(screen.getByText('2 matching · $90.60 in view')).toBeInTheDocument();
  });

  it('shows an onboarding empty state when the month has nothing at all', () => {
    renderPanel({ transactions: [], filteredTotal: 0, filteredAmount: 0, monthCount: 0 });

    expect(screen.getByText('No transactions in this month')).toBeInTheDocument();
    expect(screen.getByText(/add your first transaction/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('distinguishes an empty filter result from an empty month', async () => {
    const { props } = renderPanel({
      transactions: [],
      filteredTotal: 0,
      filteredAmount: 0,
      monthCount: 12,
      query: queryWith({ q: 'camp' }),
    });

    expect(screen.getByText('No transactions match those filters')).toBeInTheDocument();
    expect(screen.getByText(/try widening the date range/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /clear filters/i }));
    expect(props.onQueryChange).toHaveBeenCalledWith(EMPTY_QUERY);
  });

  it('offers a retry instead of an empty month when the list fails', () => {
    renderPanel({ transactions: [], error: 'Could not load transactions' });

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load transactions');
    expect(screen.queryByText('No transactions in this month')).not.toBeInTheDocument();
  });

  it('shows a loading state rather than a false empty state', () => {
    renderPanel({ transactions: [], loading: true });

    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
    expect(screen.queryByText(/no transactions/i)).not.toBeInTheDocument();
  });

  it('edit opens the chosen transaction', async () => {
    const { props } = renderPanel();

    await userEvent.click(screen.getByRole('button', { name: 'Edit Weekly shop' }));

    expect(props.onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it('delete asks the caller to delete the chosen transaction', async () => {
    const { props } = renderPanel();

    await userEvent.click(screen.getByRole('button', { name: 'Delete Train ticket' }));

    expect(props.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
  });

  it('add opens a blank form', async () => {
    const { props } = renderPanel();

    await userEvent.click(screen.getByRole('button', { name: /add transaction/i }));

    expect(props.onCreate).toHaveBeenCalled();
  });

  it('search submits trimmed text and keeps the other filters', async () => {
    const { props } = renderPanel({ query: queryWith({ sort: 'amount_desc' }) });

    await userEvent.type(screen.getByLabelText('Search'), '  coffee  ');
    await userEvent.click(screen.getByRole('button', { name: /apply filters/i }));

    expect(props.onQueryChange).toHaveBeenCalledWith(queryWith({ q: 'coffee', sort: 'amount_desc' }));
  });

  it('amount bounds submit with the search text', async () => {
    const { props } = renderPanel();

    await userEvent.type(screen.getByLabelText('Min amount'), '10');
    await userEvent.type(screen.getByLabelText('Max amount'), '99.99');
    await userEvent.click(screen.getByRole('button', { name: /apply filters/i }));

    const next = vi.mocked(props.onQueryChange).mock.calls[0]?.[0] as TransactionQuery;
    expect(next.min).toBe('10');
    expect(next.max).toBe('99.99');
  });

  it('toggles category chips on and off', async () => {
    const { props } = renderPanel();

    await userEvent.click(screen.getByRole('button', { name: 'Groceries' }));
    expect(props.onQueryChange).toHaveBeenLastCalledWith(queryWith({ category_ids: [1] }));

    await userEvent.click(screen.getByRole('button', { name: 'Transport' }));
    expect(props.onQueryChange).toHaveBeenLastCalledWith(queryWith({ category_ids: [2] }));
  });

  it('marks the active category chips for assistive technology', () => {
    renderPanel({ query: queryWith({ category_ids: [1] }) });

    expect(screen.getByRole('button', { name: 'Groceries' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Transport' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('changes sorting without losing the query', async () => {
    const { props } = renderPanel({ query: queryWith({ q: 'shop' }) });

    await userEvent.selectOptions(screen.getByLabelText('Sort by'), 'amount_asc');

    expect(props.onQueryChange).toHaveBeenCalledWith(queryWith({ q: 'shop', sort: 'amount_asc' }));
  });

  it('shows the month bounds but will not edit them while the range follows the month', () => {
    renderPanel();

    // The bounds are printed rather than blank, so the field explains what is
    // being queried instead of looking like an unfilled filter.
    expect(screen.getByLabelText('From')).toHaveValue('2026-03-01');
    expect(screen.getByLabelText('To')).toHaveValue('2026-03-31');
    expect(screen.getByLabelText('From')).toBeDisabled();
    expect(screen.getByLabelText('To')).toBeDisabled();
    expect(screen.getByText('Dates follow March 2026. Choose Custom… to pick your own.')).toBeInTheDocument();
  });

  it('choosing Custom… prefills the month it is replacing', async () => {
    const { props } = renderPanel();

    await userEvent.click(screen.getByRole('button', { name: /custom/i }));

    expect(props.onQueryChange).toHaveBeenLastCalledWith(
      queryWith({ range: 'custom', from: '2026-03-01', to: '2026-03-31' }),
    );
  });

  it('narrows the period with an explicit date range', async () => {
    const { props } = renderPanel({ query: queryWith({ range: 'custom' }) });

    expect(screen.getByLabelText('From')).toBeEnabled();

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-03-05' } });
    expect(props.onQueryChange).toHaveBeenLastCalledWith(queryWith({ range: 'custom', from: '2026-03-05' }));

    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-03-20' } });
    expect(props.onQueryChange).toHaveBeenLastCalledWith(queryWith({ range: 'custom', to: '2026-03-20' }));
  });

  it('names the dates it is showing once they stop being the selected month', () => {
    renderPanel({
      query: queryWith({ range: 'custom', from: '2026-03-05', to: '2026-03-10' }),
      filteredTotal: 2,
      filteredAmount: 90.6,
    });

    // The overview above still describes March, so the list has to say it does
    // not cover March.
    expect(screen.getByText(/2 matching · \$90\.60 in view · Mar 5 – Mar 10, 2026/)).toBeInTheDocument();
    expect(screen.getByText('Custom dates. The selected month still drives the budget and alerts.')).toBeInTheDocument();
  });

  it('"This month" moves the selected month and hands the dates back to it', async () => {
    const { props } = renderPanel({ query: queryWith({ range: 'custom', from: '2026-03-05', to: '2026-03-10' }) });

    await userEvent.click(screen.getByRole('button', { name: /this month/i }));

    // Not "the selected month" under another name: it goes to today's month and
    // clears the typed bounds, so header and list agree afterwards.
    expect(props.onPeriodChange).toHaveBeenCalledWith(currentPeriod());
    expect(props.onQueryChange).toHaveBeenCalledWith(queryWith({ range: 'period', from: null, to: null }));
  });

  it('"Last month" is one click, not a click plus a back arrow', async () => {
    const { props } = renderPanel();

    await userEvent.click(screen.getByRole('button', { name: /last month/i }));

    expect(props.onPeriodChange).toHaveBeenCalledWith(shiftPeriod(currentPeriod(), -1));
    expect(props.onQueryChange).toHaveBeenCalledWith(queryWith({ range: 'period', from: null, to: null }));
  });

  it('shows which range is in force, including when the month is neither preset', () => {
    const cases: Array<{ period: { year: number; month: number }; range: 'period' | 'custom'; pressed: string[] }> = [
      { period: currentPeriod(), range: 'period', pressed: ['This month'] },
      { period: shiftPeriod(currentPeriod(), -1), range: 'period', pressed: ['Last month'] },
      { period: { year: 2026, month: 3 }, range: 'period', pressed: [] },
      { period: { year: 2026, month: 3 }, range: 'custom', pressed: ['Custom…'] },
    ];

    for (const testCase of cases) {
      const view = renderPanel({ period: testCase.period, query: queryWith({ range: testCase.range }) });
      const pressed = screen
        .getAllByRole('button', { name: /this month|last month|custom/i })
        .filter((button) => button.getAttribute('aria-pressed') === 'true')
        .map((button) => button.textContent);
      expect(pressed).toEqual(testCase.pressed);
      view.unmount();
    }
  });

  it('clears every filter at once when any are active', async () => {
    const { props } = renderPanel({ query: queryWith({ q: 'shop', sort: 'amount_asc' }) });

    await userEvent.click(screen.getByRole('button', { name: /clear all filters/i }));

    expect(props.onQueryChange).toHaveBeenCalledWith(EMPTY_QUERY);
  });

  it('shows how many of the month matched when filters are applied', () => {
    renderPanel({ query: queryWith({ q: 'shop' }), filteredTotal: 1, filteredAmount: 84.2, monthCount: 12 });
    expect(screen.getByText(/1 matching/)).toBeInTheDocument();
  });
});

describe('Transactions pagination', () => {
  const many: ApiTransaction[] = Array.from({ length: 10 }, (_unused, index) =>
    transactionFixture({ id: index + 1, title: `Item ${String(index + 1)}` }),
  );

  it('is hidden entirely when everything fits on one page', () => {
    renderPanel({ transactions: many, filteredTotal: 10, pageCount: 1 });
    expect(screen.queryByRole('navigation', { name: /transaction pages/i })).not.toBeInTheDocument();
  });

  it('disables Previous on the first page and Next on the last', () => {
    const { unmount } = renderPanel({ transactions: many, filteredTotal: 25, pageCount: 3, page: 1 });
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /next/i })).toBeEnabled();
    unmount();

    renderPanel({ transactions: many, filteredTotal: 25, pageCount: 3, page: 3 });
    expect(screen.getByRole('button', { name: /previous/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
  });

  it('states which page of the month is showing', () => {
    renderPanel({ transactions: many, filteredTotal: 25, pageCount: 3, page: 2, monthCount: 30 });
    expect(screen.getByText(/Page 2 of 3 · 25 of 30 transactions/)).toBeInTheDocument();
  });

  it('pages forward and back', async () => {
    const { props } = renderPanel({ transactions: many, filteredTotal: 25, pageCount: 3, page: 2 });

    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(props.onPageChange).toHaveBeenCalledWith(3);

    await userEvent.click(screen.getByRole('button', { name: /previous/i }));
    expect(props.onPageChange).toHaveBeenCalledWith(1);
  });
});
