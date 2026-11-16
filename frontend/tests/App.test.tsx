// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { currentPeriod, formatMonth, shiftPeriod } from '../src/lib/format.js';
import type { ApiAlert, ApiSummary } from '../src/lib/types.js';
import { alert as alertFixture, category, emptyPage, summary as summaryFixture, transaction, user } from './fixtures.js';
import { FakeSocket, installFetch, installWebSocket, jsonResponse } from './support.js';

const categoriesResponse = {
  items: [category({ id: 1, name: 'Groceries', transaction_count: 2 }), category({ id: 2, name: 'Travel', transaction_count: 0 })],
};

const pageResponse = {
  items: [
    transaction({ id: 7, title: 'Weekly shop', amount: 84.2, category_name: 'Groceries' }),
    transaction({ id: 8, title: 'Taxi', amount: 14.5, category_name: 'Travel' }),
  ],
  total: 2,
  total_amount: 98.7,
  by_category: [
    { category_id: 1, total: 84.2 },
    { category_id: 2, total: 14.5 },
  ],
};

interface Harness {
  calls: ReturnType<typeof installFetch>;
  summary: () => ApiSummary;
  pushAlert: (item: ApiAlert) => void;
}

/**
 * A backend double with just enough state to be interesting: the month summary
 * changes when a budget is saved, and every request is recorded so a test can
 * assert on the exact query the UI produced.
 */
function renderApp(overrides: Partial<Record<string, unknown>> = {}): Promise<Harness> {
  let summary = summaryFixture();
  const routes: Record<string, () => Response> = {
    'GET /api/auth/me': () => jsonResponse({ user }),
    'GET /api/auth/providers': () =>
      jsonResponse({
        providers: [
          { name: 'google', configured: true, authorize_path: '/api/auth/google/login' },
          { name: 'github', configured: false, authorize_path: '/api/auth/github/login' },
        ],
        mock_auth_enabled: false,
      }),
    'GET /api/categories': () => jsonResponse(categoriesResponse),
    'GET /api/budgets/summary': () => jsonResponse(summary),
    'GET /api/transactions': () => jsonResponse(pageResponse),
    'POST /api/transactions': () => jsonResponse({ item: transaction({ id: 9 }) }, 201),
    'PUT /api/budgets': () => {
      summary = summaryFixture({ spent: 100, budget: summaryFixture().budget, remaining: 900, usage_percent: 10 });
      return jsonResponse({ budget: { amount: 1000 } });
    },
    'DELETE /api/budgets': () => new Response(null, { status: 204 }),
    'DELETE /api/transactions/:id': () => new Response(null, { status: 204 }),
    ...overrides,
  };

  installWebSocket();
  const calls = installFetch(routes);
  const view = render(<App />);

  return Promise.resolve({
    calls,
    summary: () => summary,
    pushAlert: (item: ApiAlert) => {
      const socket = FakeSocket.latest();
      socket.openSocket();
      socket.push({
        type: 'budget-alerts',
        channel: 'budget_alerts',
        period: summaryFixture().period,
        alerts: [item],
      });
    },
    ...view,
  }) as Promise<Harness>;
}

async function renderSignedIn(): Promise<Harness> {
  const harness = await renderApp();
  await screen.findByText('Ada Lovelace');
  return harness;
}

describe('App', () => {
  it('sends an unauthenticated visitor to the SSO screen', async () => {
    installWebSocket();
    installFetch({
      'GET /api/auth/me': () => jsonResponse({ error: { code: 'unauthorized', message: 'Sign in required' } }, 401),
      'GET /api/auth/providers': () =>
        jsonResponse({
          providers: [
            { name: 'google', configured: true, authorize_path: '/api/auth/google/login' },
            { name: 'github', configured: true, authorize_path: '/api/auth/github/login' },
          ],
          mock_auth_enabled: false,
        }),
    });
    render(<App />);

    expect(await screen.findByRole('button', { name: /continue with google/i })).toBeInTheDocument();
    expect(screen.getByText(/track spending by category/i)).toBeInTheDocument();
  });

  it('explains a sign-in the provider refused', async () => {
    // Where the browser lands after pressing Cancel on the consent sheet.
    window.history.replaceState({}, '', '/?auth_error=access_denied');
    installWebSocket();
    installFetch({
      'GET /api/auth/me': () => jsonResponse({ error: { code: 'unauthorized', message: 'Sign in required' } }, 401),
      'GET /api/auth/providers': () =>
        jsonResponse({
          providers: [
            { name: 'google', configured: true, authorize_path: '/api/auth/google/login' },
            { name: 'github', configured: true, authorize_path: '/api/auth/github/login' },
          ],
          mock_auth_enabled: false,
        }),
    });
    render(<App />);

    expect(await screen.findByText(/Sign-in was cancelled/i)).toBeInTheDocument();
    // The reason is consumed, so a reload will not raise it again.
    expect(window.location.search).toBe('');
    window.history.replaceState({}, '', '/');
  });

  it('explains when the backend cannot be reached at all', async () => {
    installWebSocket();
    installFetch({
      'GET /api/auth/me': () => {
        throw new Error('offline');
      },
    });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    render(<App />);

    expect(await screen.findByRole('button', { name: /continue with google/i })).toBeInTheDocument();
  });

  it('boots into the dashboard with the current month', async () => {
    await renderSignedIn();

    expect(screen.getByText('Expense Tracker')).toBeInTheDocument();
    // The month appears in the picker, the overview subtitle and the budget
    // field; the picker is the control that defines the period in view.
    expect(screen.getByText(formatMonth(currentPeriod()), { selector: '.month-picker__label' })).toBeInTheDocument();
    expect(await screen.findByText('Total spent')).toBeInTheDocument();
    expect(screen.getByText('$250.00')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /overview/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('lists transactions on the transactions tab', async () => {
    await renderSignedIn();

    await userEvent.click(screen.getByRole('tab', { name: /transactions/i }));

    // The panel renders a table and a card list; CSS shows one of them.
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Weekly shop')).toBeInTheDocument();
    expect(within(table).getByText('Taxi')).toBeInTheDocument();
    expect(screen.getByText('2 matching · $98.70 in view')).toBeInTheDocument();
  });

  it('creates a transaction through the modal and refetches', async () => {
    const harness = await renderSignedIn();
    await userEvent.click(screen.getByRole('tab', { name: /transactions/i }));
    await userEvent.click(screen.getByRole('button', { name: /^add transaction$/i }));

    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Title'), 'Driver donation');
    await userEvent.type(within(dialog).getByLabelText('Amount'), '12.34');
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2026-03-09' } });
    await userEvent.selectOptions(within(dialog).getByLabelText('Category'), '2');
    await userEvent.click(within(dialog).getByRole('button', { name: /add transaction$/i }));

    await waitFor(() => {
      const created = harness.calls.find((call) => call.method === 'POST');
      expect(created?.body).toEqual({
        title: 'Driver donation',
        amount: '12.34',
        currency: 'USD',
        date: '2026-03-09',
        category_id: 2,
        notes: '',
      });
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The list and the month summary are both refetched after a write.
    expect(harness.calls.filter((call) => call.path === '/api/transactions').length).toBeGreaterThan(1);
  });

  it('validates the transaction form before sending anything', async () => {
    const harness = await renderSignedIn();
    await userEvent.click(screen.getByRole('tab', { name: /transactions/i }));
    await userEvent.click(screen.getByRole('button', { name: /^add transaction$/i }));

    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Amount'), '-3');
    await userEvent.click(within(dialog).getByRole('button', { name: /add transaction$/i }));

    expect(within(dialog).getByText('Title is required')).toBeInTheDocument();
    expect(within(dialog).getByText(/positive number with at most 2 decimals/)).toBeInTheDocument();
    // The first category is preselected, so a fresh form is one keystroke away.
    expect(within(dialog).getByLabelText('Category')).toHaveValue('1');
    expect(harness.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('edits an existing transaction with a PUT', async () => {
    const harness = await renderSignedIn();
    await userEvent.click(screen.getByRole('tab', { name: /transactions/i }));

    await userEvent.click(screen.getByRole('button', { name: 'Edit Weekly shop' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.clear(within(dialog).getByLabelText('Title'));
    await userEvent.type(within(dialog).getByLabelText('Title'), 'Weekly shop (split)');
    await userEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      const updated = harness.calls.find((call) => call.method === 'PUT' && call.path === '/api/transactions/:id');
      expect(updated?.body).toMatchObject({ title: 'Weekly shop (split)' });
    });
  });

  it('deletes only after an explicit confirmation', async () => {
    const harness = await renderSignedIn();
    await userEvent.click(screen.getByRole('tab', { name: /transactions/i }));

    await userEvent.click(screen.getByRole('button', { name: 'Delete Taxi' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/removed permanently/i)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: /keep it/i }));
    expect(harness.calls.some((call) => call.method === 'DELETE' && call.path === '/api/transactions/:id')).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Delete Taxi' }));
    const confirm = await screen.findByRole('dialog');
    await userEvent.click(within(confirm).getByRole('button', { name: /delete transaction/i }));

    await waitFor(() =>
      expect(harness.calls.some((call) => call.method === 'DELETE' && call.path === '/api/transactions/:id')).toBe(true),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('manages categories on the categories tab', async () => {
    const harness = await renderSignedIn();
    await userEvent.click(screen.getByRole('tab', { name: /categories/i }));

    await userEvent.type(screen.getByLabelText('New category'), 'Utilities');
    await userEvent.click(screen.getByRole('button', { name: /add category/i }));

    await waitFor(() => {
      const created = harness.calls.find((call) => call.method === 'POST' && call.path === '/api/categories');
      expect(created?.body).toEqual({ name: 'Utilities' });
    });
    // An in-use category is listed but not deletable.
    expect(screen.getByText('2 transactions')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Groceries' })).toBeDisabled();
  });

  it('navigates months and asks the backend for that period', async () => {
    const harness = await renderSignedIn();
    const next = shiftPeriod(currentPeriod(), 1);

    await userEvent.click(screen.getByRole('button', { name: 'Next month' }));

    expect(await screen.findByText(formatMonth(next))).toBeInTheDocument();
    await waitFor(() => {
      const summaryCall = harness.calls.find(
        (call) => call.path === '/api/budgets/summary' && call.query.includes(`year=${String(next.year)}`),
      );
      expect(summaryCall).toBeDefined();
    });
    // The transaction range follows the month that is now in view, and paging
    // travels with it as limit/offset.
    const listCall = harness.calls.find(
      (call) =>
        call.method === 'GET' &&
        call.path === '/api/transactions' &&
        call.query.includes(`from=${String(next.year)}-${String(next.month).padStart(2, '0')}-01`),
    );
    expect(listCall?.query).toContain('limit=10');
    expect(listCall?.query).toContain('offset=0');
  });

  it('saves a budget from the dashboard and refreshes the numbers', async () => {
    const harness = await renderSignedIn();

    await userEvent.clear(screen.getByLabelText(`Budget for ${formatMonth(summaryFixture().period)}`));
    await userEvent.type(screen.getByLabelText(`Budget for ${formatMonth(summaryFixture().period)}`), '1000');
    await userEvent.click(screen.getByRole('button', { name: /save budget/i }));

    await waitFor(() => {
      const saved = harness.calls.find((call) => call.method === 'PUT' && call.path === '/api/budgets');
      expect(saved?.body).toMatchObject({ amount: '1000', currency: 'USD' });
    });
    expect(await screen.findByText('10%')).toBeInTheDocument();
  });

  it('shows a live budget alert as a toast and acks it over the socket', async () => {
    const harness = await renderSignedIn();
    const socket = FakeSocket.latest();
    act(() => socket.openSocket());

    const item = alertFixture({ threshold: 80, new: true, spent: 800, usage_percent: 80 });
    act(() =>
      socket.push({
        type: 'budget-alerts',
        channel: 'budget_alerts',
        period: item.period,
        alerts: [item],
      }),
    );

    expect((await screen.findAllByText(/80% of budget used/i)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('$800.00 of $1,000.00 spent (80%).')).length).toBeGreaterThan(0);

    const toasts = document.querySelector('.toasts');
    if (!toasts) throw new Error('toast container missing');
    await userEvent.click(within(toasts as HTMLElement).getByRole('button', { name: /mark read/i }));

    expect(socket.parsed().some((frame) => frame.type === 'ack' && frame.threshold === 80)).toBe(true);
    expect(harness.calls.length).toBeGreaterThan(0);
  });

  it('marks an unread alert in the overview tab badge', async () => {
    await renderSignedIn();
    const socket = FakeSocket.latest();
    act(() => socket.openSocket());

    act(() =>
      socket.push({
        type: 'budget-alerts',
        channel: 'budget_alerts',
        period: summaryFixture().period,
        alerts: [alertFixture({ threshold: 50, new: false, read: false })],
      }),
    );

    expect(await screen.findByText('50% of budget used — March 2026')).toBeInTheDocument();
  });

  it('surfaces a failed transactions load instead of an empty month', async () => {
    await renderApp({
      'GET /api/transactions': () => jsonResponse({ error: { code: 'boom', message: 'Database is busy' } }, 500),
    });
    await screen.findByText('Ada Lovelace');

    await userEvent.click(screen.getByRole('tab', { name: /transactions/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Database is busy');
    expect(screen.queryByText('No transactions in this month')).not.toBeInTheDocument();
  });

  it('keeps working when a month has no transactions at all', async () => {
    await renderApp({ 'GET /api/transactions': () => jsonResponse(emptyPage) });
    await screen.findByText('Ada Lovelace');

    await userEvent.click(screen.getByRole('tab', { name: /transactions/i }));

    expect(await screen.findByText('No transactions in this month')).toBeInTheDocument();
  });
});
