import { useEffect, useState } from 'react';
import { currentPeriod, formatDateRange, formatMoney, formatDay, formatMonth, periodBounds, resolveDateRange, samePeriod, shiftPeriod } from '../lib/format.js';
import type { ApiCategory, ApiTransaction, Period, TransactionQuery } from '../lib/types.js';
import { EMPTY_QUERY } from '../lib/types.js';
import { EmptyState, ErrorBanner, LoadingBlock } from './ui.js';

const SORT_LABELS: Array<[string, string]> = [
  ['date_desc', 'Newest date'],
  ['date_asc', 'Oldest date'],
  ['amount_desc', 'Highest amount'],
  ['amount_asc', 'Lowest amount'],
];

interface TransactionsProps {
  period: Period;
  categories: ApiCategory[];
  transactions: ApiTransaction[];
  filteredTotal: number;
  filteredAmount: number;
  monthCount: number;
  page: number;
  pageCount: number;
  query: TransactionQuery;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onQueryChange: (query: TransactionQuery) => void;
  onPeriodChange: (period: Period) => void;
  onPageChange: (page: number) => void;
  onEdit: (transaction: ApiTransaction) => void;
  onDelete: (transaction: ApiTransaction) => void;
  onCreate: () => void;
}

export function Transactions(props: TransactionsProps): React.JSX.Element {
  const filtersActive = countActiveFilters(props.query);

  return (
    <section className="card" aria-labelledby="transactions-heading">
      <div className="card__head">
        <h2 id="transactions-heading">Transactions</h2>
        <span className="card__subtitle">{summaryLine(props)}</span>
        <span className="spacer" />
        <button type="button" className="btn btn--sm" onClick={props.onCreate}>
          Add transaction
        </button>
      </div>

      <FilterBar
        period={props.period}
        categories={props.categories}
        query={props.query}
        filtersActive={filtersActive}
        onQueryChange={props.onQueryChange}
        onPeriodChange={props.onPeriodChange}
      />

      {props.error ? <ErrorBanner message={props.error} onRetry={props.onRetry} /> : null}

      {props.loading ? <LoadingBlock rows={6} /> : null}

      {!props.loading && props.transactions.length === 0 && !props.error ? (
        <TransactionsEmpty
          filtersActive={filtersActive}
          onClearFilters={() => props.onQueryChange(EMPTY_QUERY)}
          onCreate={props.onCreate}
        />
      ) : null}

      {!props.loading && props.transactions.length > 0 ? (
        <>
          <div className="tx-table-wrap">
            <table className="tx-table">
              <caption className="visually-hidden">Transactions for the selected month and filters</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Title</th>
                  <th scope="col">Category</th>
                  <th scope="col" className="is-num">
                    Amount
                  </th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {props.transactions.map((transaction) => (
                  <tr key={transaction.id}>
                    <td className="tx-date">{formatDay(transaction.date)}</td>
                    <td>
                      <span className="tx-title">{transaction.title}</span>
                      {transaction.notes ? <span className="tx-notes">{transaction.notes}</span> : null}
                    </td>
                    <td>
                      <span className="badge">{transaction.category_name ?? 'Uncategorized'}</span>
                    </td>
                    <td className="is-num tx-amount">{formatMoney(transaction.amount, transaction.currency)}</td>
                    <td>
                      <div className="tx-actions">
                        <button
                          type="button"
                          className="icon-btn"
                          onClick={() => props.onEdit(transaction)}
                          aria-label={`Edit ${transaction.title}`}
                        >
                          ✏️
                        </button>
                        <button
                          type="button"
                          className="icon-btn icon-btn--danger"
                          onClick={() => props.onDelete(transaction)}
                          aria-label={`Delete ${transaction.title}`}
                        >
                          🗑
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="tx-cards">
            {props.transactions.map((transaction) => (
              <article className="tx-card" key={transaction.id}>
                <div className="tx-card__top">
                  <span className="tx-title">{transaction.title}</span>
                  <span className="spacer" />
                  <span className="tx-amount">{formatMoney(transaction.amount, transaction.currency)}</span>
                </div>
                <div className="row row--tight">
                  <span className="badge">{transaction.category_name ?? 'Uncategorized'}</span>
                  <span className="tx-date">{formatDay(transaction.date)}</span>
                </div>
                {transaction.notes ? <p className="tx-notes">{transaction.notes}</p> : null}
                <div className="row row--tight">
                  <button type="button" className="btn btn--secondary btn--sm" onClick={() => props.onEdit(transaction)}>
                    Edit
                  </button>
                  <button type="button" className="btn btn--danger btn--sm" onClick={() => props.onDelete(transaction)}>
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>

          <Pagination
            page={props.page}
            pageCount={props.pageCount}
            filteredTotal={props.filteredTotal}
            monthCount={props.monthCount}
            onPageChange={props.onPageChange}
          />
        </>
      ) : null}
    </section>
  );
}

/**
 * Two distinct empty states: an empty month invites the first transaction,
 * while an empty filter result invites the user to loosen what they typed.
 * A failed request renders neither — the caller shows the error instead.
 */
function TransactionsEmpty(props: {
  filtersActive: number;
  onClearFilters: () => void;
  onCreate: () => void;
}): React.JSX.Element {
  if (props.filtersActive === 0) {
    return (
      <EmptyState
        icon="🧾"
        title="No transactions in this month"
        body="Add your first transaction to start tracking spending against the monthly budget."
        action={
          <button type="button" className="btn btn--sm" onClick={props.onCreate}>
            Add transaction
          </button>
        }
      />
    );
  }
  return (
    <EmptyState
      icon="🔍"
      title="No transactions match those filters"
      body="Try widening the date range, clearing a category, or searching for less text."
      action={
        <button type="button" className="btn btn--secondary btn--sm" onClick={props.onClearFilters}>
          Clear filters
        </button>
      }
    />
  );
}

function countActiveFilters(query: TransactionQuery): number {
  let active = 0;
  if (query.q !== '') active += 1;
  if (query.category_ids.length > 0) active += 1;
  // The range counts as a filter only when it has left the selected month.
  if (query.range === 'custom') active += 1;
  if (query.min !== '') active += 1;
  if (query.max !== '') active += 1;
  if (query.sort !== EMPTY_QUERY.sort) active += 1;
  return active;
}

/**
 * Totals for what is on screen, and the dates they cover when those dates are
 * not simply the selected month. Naming the range is the point: it is the one
 * place the UI can admit that the list and the overview are looking at
 * different periods, which is only possible in custom mode.
 */
function summaryLine(props: TransactionsProps): string {
  if (props.transactions.length === 0) return 'Nothing recorded yet';
  const totals = `${String(props.filteredTotal)} matching · ${formatMoney(props.filteredAmount)} in view`;
  if (props.query.range !== 'custom') return totals;
  const range = resolveDateRange(props.period, props.query);
  return `${totals} · ${formatDateRange(range.from, range.to)}`;
}

interface FilterBarProps {
  period: Period;
  categories: ApiCategory[];
  query: TransactionQuery;
  filtersActive: number;
  onQueryChange: (query: TransactionQuery) => void;
  onPeriodChange: (period: Period) => void;
}

function FilterBar(props: FilterBarProps): React.JSX.Element {
  const [search, setSearch] = useState(props.query.q);
  const [min, setMin] = useState(props.query.min);
  const [max, setMax] = useState(props.query.max);

  // Keep the local text fields in step with externally reset filters.
  useEffect(() => {
    setSearch(props.query.q);
    setMin(props.query.min);
    setMax(props.query.max);
  }, [props.query.q, props.query.min, props.query.max]);

  const bounds = periodBounds(props.period);
  const followingMonth = props.query.range === 'period';
  const today = currentPeriod();
  const lastMonth = shiftPeriod(today, -1);
  const customFrom = props.query.from ?? bounds.from;
  const customTo = props.query.to ?? bounds.to;

  const toggleCategory = (id: number): void => {
    const next = props.query.category_ids.includes(id)
      ? props.query.category_ids.filter((value) => value !== id)
      : [...props.query.category_ids, id];
    props.onQueryChange({ ...props.query, category_ids: next });
  };

  /**
   * "This month" and "Last month" are shortcuts to a month, not a second range
   * concept: they move the selected month and hand the dates back to it, so the
   * list follows the header the way it already does whenever the month changes.
   * The button that used to stand here said "This month" while meaning "the
   * selected month", and it was the only way out of a typed range.
   */
  const selectMonth = (period: Period): void => {
    props.onPeriodChange(period);
    props.onQueryChange({ ...props.query, range: 'period', from: null, to: null });
  };

  const rangePresets: Array<{ label: string; pressed: boolean; select: () => void }> = [
    {
      label: 'This month',
      pressed: followingMonth && samePeriod(props.period, today),
      select: () => selectMonth(today),
    },
    {
      label: 'Last month',
      pressed: followingMonth && samePeriod(props.period, lastMonth),
      select: () => selectMonth(lastMonth),
    },
    {
      label: 'Custom…',
      pressed: !followingMonth,
      select: () =>
        props.onQueryChange({
          ...props.query,
          range: 'custom',
          from: props.query.from ?? bounds.from,
          to: props.query.to ?? bounds.to,
        }),
    },
  ];

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        props.onQueryChange({ ...props.query, q: search.trim(), min: min.trim(), max: max.trim() });
      }}
    >
      <div className="chip-row" role="group" aria-label="Date range">
        {rangePresets.map((preset) => (
          <button
            key={preset.label}
            type="button"
            className="chip"
            aria-pressed={preset.pressed}
            onClick={preset.select}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <p className="field__hint">
        {followingMonth
          ? `Dates follow ${formatMonth(props.period)}. Choose Custom… to pick your own.`
          : 'Custom dates. The selected month still drives the budget and alerts.'}
      </p>

      <div className="filters">
        <div className="field">
          <label className="field__label" htmlFor="filter-search">
            Search
          </label>
          <input
            id="filter-search"
            className="input"
            type="search"
            placeholder="Title or notes"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="filter-from">
            From
          </label>
          <input
            id="filter-from"
            className="input"
            type="date"
            value={customFrom}
            disabled={followingMonth}
            onChange={(event) => props.onQueryChange({ ...props.query, from: event.target.value })}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="filter-to">
            To
          </label>
          <input
            id="filter-to"
            className="input"
            type="date"
            value={customTo}
            disabled={followingMonth}
            onChange={(event) => props.onQueryChange({ ...props.query, to: event.target.value })}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="filter-min">
            Min amount
          </label>
          <input
            id="filter-min"
            className="input"
            inputMode="decimal"
            placeholder="0.00"
            value={min}
            onChange={(event) => setMin(event.target.value)}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="filter-max">
            Max amount
          </label>
          <input
            id="filter-max"
            className="input"
            inputMode="decimal"
            placeholder="Unlimited"
            value={max}
            onChange={(event) => setMax(event.target.value)}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="filter-sort">
            Sort by
          </label>
          <select
            id="filter-sort"
            className="select"
            value={props.query.sort}
            onChange={(event) => props.onQueryChange({ ...props.query, sort: event.target.value })}
          >
            {SORT_LABELS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {props.categories.length > 0 ? (
        <div className="chip-row" role="group" aria-label="Filter by category">
          {props.categories.map((category) => {
            const pressed = props.query.category_ids.includes(category.id);
            return (
              <button
                key={category.id}
                type="button"
                className="chip"
                aria-pressed={pressed}
                onClick={() => toggleCategory(category.id)}
              >
                {category.name}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="row row--tight">
        <button type="submit" className="btn btn--secondary btn--sm">
          Apply filters
        </button>
        {props.filtersActive > 0 ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => props.onQueryChange(EMPTY_QUERY)}>
            Clear all filters
          </button>
        ) : null}
      </div>
    </form>
  );
}

function Pagination(props: {
  page: number;
  pageCount: number;
  filteredTotal: number;
  monthCount: number;
  onPageChange: (page: number) => void;
}): React.JSX.Element | null {
  if (props.pageCount <= 1) return null;
  return (
    <nav className="row" aria-label="Transaction pages">
      <button
        type="button"
        className="btn btn--secondary btn--sm"
        onClick={() => props.onPageChange(props.page - 1)}
        disabled={props.page <= 1}
      >
        Previous
      </button>
      <span className="card__subtitle">
        Page {String(props.page)} of {String(props.pageCount)} · {String(props.filteredTotal)} of{' '}
        {String(props.monthCount)} transactions
      </span>
      <button
        type="button"
        className="btn btn--secondary btn--sm"
        onClick={() => props.onPageChange(props.page + 1)}
        disabled={props.page >= props.pageCount}
      >
        Next
      </button>
    </nav>
  );
}
