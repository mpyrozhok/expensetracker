import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { clampPercent, formatMoney, formatMonth, percent, periodLabel } from '../lib/format.js';
import { validateBudgetAmount } from '../lib/validation.js';
import type { ApiSummary, Period } from '../lib/types.js';
import { ErrorBanner, Field, LoadingBlock, Stat } from './ui.js';

interface DashboardProps {
  period: Period;
  summary: ApiSummary | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onChanged: () => void;
  onError: (message: string) => void;
}

/** Dashboard for one month: totals, budget usage, and the budget editor. */
export function Dashboard(props: DashboardProps): React.JSX.Element {
  const { summary } = props;

  return (
    <section className="card" aria-labelledby="overview-heading">
      <div className="card__head">
        <h2 id="overview-heading">Overview</h2>
        <span className="card__subtitle">{summary ? periodLabel(summary.period) : formatMonth(props.period)}</span>
      </div>

      {props.error ? <ErrorBanner message={props.error} onRetry={props.onRetry} /> : null}

      {props.loading && summary === null ? (
        <div className="stack">
          <div className="grid grid--stats">
            <div className="skeleton skeleton--stat" />
            <div className="skeleton skeleton--stat" />
            <div className="skeleton skeleton--stat" />
            <div className="skeleton skeleton--stat" />
          </div>
          <LoadingBlock rows={1} />
        </div>
      ) : null}

      {summary ? <SummaryBody summary={summary} onChanged={props.onChanged} onError={props.onError} /> : null}
    </section>
  );
}

function SummaryBody(props: { summary: ApiSummary; onChanged: () => void; onError: (message: string) => void }): React.JSX.Element {
  const { summary } = props;
  const budget = summary.budget;
  const over = summary.remaining !== null && summary.remaining < 0;

  return (
    <div className="stack">
      <div className="grid grid--stats">
        <Stat
          label="Total spent"
          value={formatMoney(summary.spent, summary.currency)}
          meta={`${String(summary.transaction_count)} transaction${summary.transaction_count === 1 ? '' : 's'} in ${formatMonth(summary.period)}`}
        />
        <Stat
          label="Budget"
          value={budget ? formatMoney(budget.amount, summary.currency) : 'Not set'}
          meta={budget ? 'Monthly limit' : 'Add a budget to track usage'}
        />
        <Stat
          label="Remaining"
          value={summary.remaining === null ? '—' : formatMoney(summary.remaining, summary.currency)}
          tone={over ? 'over' : 'default'}
          meta={over ? 'Over budget' : 'Left to spend'}
        />
        <Stat
          label="Budget used"
          value={percent(summary.usage_percent)}
          tone={summary.usage_percent !== null && summary.usage_percent >= 100 ? 'over' : 'default'}
          meta={summary.usage_percent === null ? 'Needs a budget' : 'Spent against budget'}
        />
      </div>

      {summary.usage_percent === null ? (
        <p className="card__subtitle">
          No budget for {formatMonth(summary.period)} yet — set one below to enable 50% / 80% / 100% alerts.
        </p>
      ) : (
        <UsageBar summary={summary} />
      )}

      <BudgetEditor summary={summary} onChanged={props.onChanged} onError={props.onError} />
    </div>
  );
}

/**
 * Progress toward the budget. Width comes from a fixed set of 5% classes rather
 * than an inline style, so the value is still exact to within one step while the
 * markup stays style-free.
 */
function UsageBar({ summary }: { summary: ApiSummary }): React.JSX.Element {
  const usage = summary.usage_percent ?? 0;
  const step = Math.round(clampPercent(usage) / 5) * 5;
  const classes = [`w-${String(step)}`, 'progress__bar', barTone(usage)];

  return (
    <div>
      <div
        className="progress"
        role="progressbar"
        aria-valuenow={Math.round(usage)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Budget used"
      >
        <div className={classes.join(' ')} />
      </div>
      <p className="field__hint">
        {formatMoney(summary.spent, summary.currency)} of {formatMoney(summary.budget?.amount ?? 0, summary.currency)} used
        {usage > 100 ? ` — ${percent(usage - 100)} over the limit` : ''}
      </p>
    </div>
  );
}

function barTone(usage: number): string {
  if (usage >= 100) return 'progress__bar--over';
  if (usage >= 80) return 'progress__bar--warn';
  return '';
}

function BudgetEditor(props: { summary: ApiSummary; onChanged: () => void; onError: (message: string) => void }): React.JSX.Element {
  const current = props.summary.budget?.amount;
  const [amount, setAmount] = useState(current === undefined ? '' : String(current));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);

  // Re-seed the field when the month (and therefore the budget) changes.
  useEffect(() => {
    setAmount(current === undefined ? '' : String(current));
    setError(null);
  }, [props.summary.period.year, props.summary.period.month, current]);

  const save = async (): Promise<void> => {
    const invalid = validateBudgetAmount(amount);
    setError(invalid);
    if (invalid !== null) return;
    setSaving(true);
    try {
      await api.budgets.set(props.summary.period, amount.trim());
      props.onChanged();
    } catch (failure) {
      props.onError(failure instanceof Error ? failure.message : 'Could not save the budget');
    } finally {
      setSaving(false);
    }
  };

  const clear = async (): Promise<void> => {
    setClearing(true);
    try {
      await api.budgets.remove(props.summary.period);
      props.onChanged();
    } catch (failure) {
      props.onError(failure instanceof Error ? failure.message : 'Could not clear the budget');
    } finally {
      setClearing(false);
    }
  };

  const busy = saving || clearing;

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Field
        label={`Budget for ${formatMonth(props.summary.period)}`}
        htmlFor="budget-amount"
        error={error ?? undefined}
        hint="Amounts are in US dollars (USD)."
      >
        <span className="input-group">
          <span className="input-group__prefix" aria-hidden="true">
            $
          </span>
          <input
            id="budget-amount"
            className={error ? 'input input--invalid' : 'input'}
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            aria-invalid={error !== null}
            onChange={(event) => {
              setAmount(event.target.value);
              if (error) setError(null);
            }}
          />
        </span>
      </Field>

      <div className="row row--tight">
        <button type="submit" className="btn btn--sm" disabled={busy}>
          {saving ? 'Saving…' : 'Save budget'}
        </button>
        {props.summary.budget ? (
          <button type="button" className="btn btn--danger btn--sm" onClick={() => void clear()} disabled={busy}>
            {clearing ? 'Clearing…' : 'Clear budget'}
          </button>
        ) : null}
      </div>
    </form>
  );
}
