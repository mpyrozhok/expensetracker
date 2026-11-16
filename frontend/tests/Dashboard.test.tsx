// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Dashboard } from '../src/components/Dashboard.js';
import { api } from '../src/lib/api.js';
import type { ApiSummary } from '../src/lib/types.js';
import { summary as summaryFixture } from './fixtures.js';

const period = { year: 2026, month: 3 };

function renderDashboard(overrides: Partial<React.ComponentProps<typeof Dashboard>> = {}) {
  const props = {
    period,
    summary: summaryFixture(),
    loading: false,
    error: null,
    onRetry: vi.fn(),
    onChanged: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
  render(<Dashboard {...props} />);
  return props;
}

describe('Dashboard', () => {
  it('reports spent, budget, remaining and usage for the month', () => {
    renderDashboard();

    expect(screen.getByText('$250.00')).toBeInTheDocument();
    expect(screen.getByText('$1,000.00')).toBeInTheDocument();
    expect(screen.getByText('$750.00')).toBeInTheDocument();
    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(screen.getByText('4 transactions in March 2026')).toBeInTheDocument();
  });

  it('seeds the budget field from the stored budget', () => {
    renderDashboard();
    expect(screen.getByLabelText('Budget for March 2026')).toHaveValue('1000');
  });

  it('is explicit when no budget exists yet, and points at the alerts it would enable', () => {
    renderDashboard({ summary: summaryFixture({ budget: null, remaining: null, usage_percent: null }) });

    expect(screen.getByText('Not set')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText(/no budget for march 2026/i)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('marks an over-budget month in the over state', () => {
    renderDashboard({ summary: summaryFixture({ spent: 1200, remaining: -200, usage_percent: 120 }) });

    expect(screen.getByText('-$200.00')).toHaveClass('stat__value--over');
    expect(screen.getByText('Over budget')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '120');
    expect(screen.getByText(/20% over the limit/)).toBeInTheDocument();
  });

  it('renders the usage bar at full width once the budget is exceeded', () => {
    renderDashboard({ summary: summaryFixture({ spent: 1200, remaining: -200, usage_percent: 120 }) });
    const bar = screen.getByRole('progressbar').firstElementChild;
    expect(bar?.className).toContain('w-100');
    expect(bar?.className).toContain('progress__bar--over');
  });

  it('warns at 80% and above, and stays neutral below it', () => {
    const warn = render(
      <Dashboard {...dashboardProps(summaryFixture({ spent: 850, remaining: 150, usage_percent: 85 }))} />,
    );
    expect(screen.getByRole('progressbar').firstElementChild?.className).toContain('progress__bar--warn');
    warn.unmount();

    render(<Dashboard {...dashboardProps(summaryFixture({ spent: 40, remaining: 960, usage_percent: 4 }))} />);
    expect(screen.getByRole('progressbar').firstElementChild?.className).not.toContain('progress__bar--warn');
  });

  it('shows a loading state instead of an empty month while fetching', () => {
    renderDashboard({ summary: null, loading: true });

    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
    expect(screen.queryByText('Total spent')).not.toBeInTheDocument();
  });

  it('surfaces a load failure with a retry', async () => {
    const onRetry = vi.fn();
    renderDashboard({ summary: null, error: 'Could not load the month summary', onRetry });

    await userEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the month summary');
    expect(onRetry).toHaveBeenCalled();
  });

  it('saves a new budget and asks the caller to refresh', async () => {
    const set = vi.spyOn(api.budgets, 'set').mockResolvedValue({ budget: { amount: 1200 } });
    const props = renderDashboard();

    await userEvent.clear(screen.getByLabelText('Budget for March 2026'));
    await userEvent.type(screen.getByLabelText('Budget for March 2026'), '1200');
    await userEvent.click(screen.getByRole('button', { name: /save budget/i }));

    await waitFor(() => expect(set).toHaveBeenCalledWith(period, '1200'));
    expect(props.onChanged).toHaveBeenCalled();
  });

  it('rejects an invalid amount locally, without calling the API', async () => {
    const set = vi.spyOn(api.budgets, 'set').mockResolvedValue({ budget: { amount: 1 } });
    renderDashboard();

    await userEvent.clear(screen.getByLabelText('Budget for March 2026'));
    await userEvent.type(screen.getByLabelText('Budget for March 2026'), '0');
    await userEvent.click(screen.getByRole('button', { name: /save budget/i }));

    expect(screen.getByText('Budget must be greater than 0')).toBeInTheDocument();
    expect(screen.getByLabelText('Budget for March 2026')).toHaveAttribute('aria-invalid', 'true');
    expect(set).not.toHaveBeenCalled();
  });

  it('surfaces a server rejection when saving', async () => {
    vi.spyOn(api.budgets, 'set').mockRejectedValue(new Error('Budget amount must be positive'));
    const props = renderDashboard();

    await userEvent.click(screen.getByRole('button', { name: /save budget/i }));

    expect(props.onError).toHaveBeenCalledWith('Budget amount must be positive');
  });

  it('clears the budget when the month has one', async () => {
    const remove = vi.spyOn(api.budgets, 'remove').mockResolvedValue(undefined);
    const props = renderDashboard();

    await userEvent.click(screen.getByRole('button', { name: /clear budget/i }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith(period));
    expect(props.onChanged).toHaveBeenCalled();
  });

  it('re-seeds the field when the selected month changes', async () => {
    const { rerender } = render(
      <Dashboard {...dashboardProps(summaryFixture({ budget: null, remaining: null, usage_percent: null }))} />,
    );
    expect(screen.getByLabelText('Budget for March 2026')).toHaveValue('');

    rerender(
      <Dashboard
        {...dashboardProps(
          summaryFixture({
            budget: { year: 2026, month: 3, amount: 750, currency: 'USD' },
            spent: 100,
            remaining: 650,
            usage_percent: 13.3,
          }),
        )}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText('Budget for March 2026')).toHaveValue('750'));
  });
});

function dashboardProps(summary: ApiSummary | null): React.ComponentProps<typeof Dashboard> {
  return {
    period,
    summary,
    loading: false,
    error: null,
    onRetry: vi.fn(),
    onChanged: vi.fn(),
    onError: vi.fn(),
  };
}
