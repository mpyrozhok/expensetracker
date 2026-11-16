import { useCallback, useEffect, useState } from 'react';
import { AlertsPanel, AlertToaster } from './components/AlertsPanel.js';
import { Categories } from './components/Categories.js';
import { Dashboard } from './components/Dashboard.js';
import { LoginScreen, type ProviderInfo } from './components/LoginScreen.js';
import { TransactionModal } from './components/TransactionModal.js';
import { Transactions } from './components/Transactions.js';
import { Avatar, EmptyState, ErrorBanner } from './components/ui.js';
import { useBudgetAlerts } from './hooks/useBudgetAlerts.js';
import { useExpenseData } from './hooks/useExpenseData.js';
import { api } from './lib/api.js';
import { currentPeriod, describeAuthError, formatMonth, shiftPeriod } from './lib/format.js';
import type { ApiTransaction, ApiUser, Period } from './lib/types.js';

type Tab = 'overview' | 'transactions' | 'categories';

export function App(): React.JSX.Element {
  const [user, setUser] = useState<ApiUser | null>(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // The session cookie is the source of truth, so a refresh restores the user
    // without any client-side token storage.
    api
      .me()
      .then((result) => {
        if (!cancelled) setUser(result.user);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setBooting(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (booting) return <BootScreen />;
  if (!user) return <AuthGate onSignedIn={setUser} />;
  return <Workspace user={user} onSignedOut={() => setUser(null)} />;
}

function BootScreen(): React.JSX.Element {
  return (
    <main className="login">
      <div className="login__card stack">
        <h1 className="login__title">Expense Tracker</h1>
        <p className="card__subtitle">Restoring your session…</p>
        <div className="skeleton skeleton--row" />
        <div className="skeleton skeleton--row" />
      </div>
    </main>
  );
}

function AuthGate(props: { onSignedIn: (user: ApiUser) => void }): React.JSX.Element {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [mockEnabled, setMockEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A sign-in the provider refused comes back as ?auth_error=... on this page.
  // It is shown in its own state so a later "backend unreachable" message cannot
  // overwrite the reason the user is looking for.
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const refusal = describeAuthError(params.get('auth_error'));
    if (refusal === null) return;
    setAuthError(refusal);
    // Consume it, so reloading does not reopen a consent sheet that long closed.
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  useEffect(() => {
    api
      .providers()
      .then((result) => {
        setProviders(result.providers);
        setMockEnabled(result.mock_auth_enabled);
      })
      .catch(() => {
        // A backend that is unreachable still deserves a readable screen.
        setProviders([
          { name: 'google', configured: false, authorize_path: '/api/auth/google/login' },
          { name: 'github', configured: false, authorize_path: '/api/auth/github/login' },
        ]);
        setError('Could not reach the backend. Start it with npm run dev, then reload this page.');
      });
  }, []);

  return (
    <LoginScreen
      providers={providers}
      mockEnabled={mockEnabled}
      error={authError ?? error}
      onError={setError}
      onSignedIn={async () => {
        try {
          const result = await api.me();
          props.onSignedIn(result.user);
        } catch {
          setError('Signed in, but the session could not be read. Reload to try again.');
        }
      }}
    />
  );
}

function Workspace(props: { user: ApiUser; onSignedOut: () => void }): React.JSX.Element {
  const [period, setPeriod] = useState<Period>(currentPeriod());
  const [tab, setTab] = useState<Tab>('overview');
  const [notice, setNotice] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ApiTransaction | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ApiTransaction | null>(null);
  const data = useExpenseData(period);
  const alerts = useBudgetAlerts(period, true);

  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const reportError = useCallback((message: string) => setNotice(message), []);

  const signOut = async (): Promise<void> => {
    try {
      await api.logout();
    } finally {
      props.onSignedOut();
    }
  };

  const saveTransaction = async (payload: Record<string, string | number | null>): Promise<void> => {
    if (editing) {
      await data.updateTransaction(editing.id, payload);
      return;
    }
    await data.createTransaction(payload);
  };

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return;
    try {
      await data.deleteTransaction(pendingDelete.id);
      setPendingDelete(null);
    } catch (failure) {
      reportError(failure instanceof Error ? failure.message : 'Could not delete the transaction');
    }
  };

  const monthLabel = formatMonth(period);
  const unread = alerts.unreadCount;

  return (
    <>
      <header className="app-header">
        <span className="app-header__brand">
          <span aria-hidden="true">💸</span> Expense Tracker
        </span>
        <span className="app-header__spacer" />
        <ConnectionControl status={alerts.status} onReconnect={alerts.reconnect} />
        <span className="user-chip">
          <Avatar name={props.user.display_name} url={props.user.avatar_url} />
          <span>{props.user.display_name}</span>
        </span>
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>

      <nav className="tabs" aria-label="Sections">
        <TabButton id="overview" label="Overview" active={tab} onSelect={setTab} badge={unread} />
        <TabButton id="transactions" label="Transactions" active={tab} onSelect={setTab} badge={0} />
        <TabButton id="categories" label="Categories" active={tab} onSelect={setTab} badge={0} />
      </nav>

      <main className="page">
        <MonthBar period={period} onChange={setPeriod} />

        {notice ? <ErrorBanner message={notice} onRetry={() => setNotice(null)} /> : null}

        {tab === 'overview' ? (
          <>
            <Dashboard
              period={period}
              summary={data.summary}
              loading={data.loadingSummary}
              error={data.summaryError}
              onRetry={data.refreshAll}
              onChanged={data.refreshAll}
              onError={reportError}
            />
            <AlertsPanel
              alerts={alerts.alerts}
              status={alerts.status}
              onAck={alerts.markRead}
              periodLabel={monthLabel}
            />
          </>
        ) : null}

        {tab === 'transactions' ? (
          <Transactions
            period={period}
            categories={data.categories}
            transactions={data.transactions}
            filteredTotal={data.filteredTotal}
            filteredAmount={data.filteredAmount}
            monthCount={data.summary?.transaction_count ?? 0}
            page={data.page}
            pageCount={data.pageCount}
            query={data.query}
            loading={data.loadingTransactions}
            error={data.transactionsError}
            onRetry={data.refreshAll}
            onQueryChange={data.setQuery}
            onPageChange={data.setPage}
            onEdit={(transaction) => {
              setEditing(transaction);
              setFormOpen(true);
            }}
            onDelete={setPendingDelete}
            onCreate={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          />
        ) : null}

        {tab === 'categories' ? (
          <Categories
            categories={data.categories}
            loading={data.loadingCategories}
            error={data.categoriesError}
            onRetry={data.refreshAll}
            onCreate={async (name) => {
              await data.createCategory(name);
            }}
            onRename={async (id, name) => {
              await data.renameCategory(id, name);
            }}
            onDelete={async (id) => {
              await data.deleteCategory(id);
            }}
          />
        ) : null}

        {data.categories.length === 0 && !data.loadingCategories && tab !== 'categories' ? (
          <EmptyState
            icon="🏷"
            title="Start by adding a category"
            body="Transactions are filed under a category, which is what powers the budget breakdown and alerts."
            action={
              <button type="button" className="btn btn--sm" onClick={() => setTab('categories')}>
                Go to categories
              </button>
            }
          />
        ) : null}
      </main>

      <TransactionModal
        open={formOpen}
        transaction={editing}
        categories={data.categories}
        defaultDate={periodDefaults(period)}
        onClose={() => setFormOpen(false)}
        onSaved={saveTransaction}
        onError={reportError}
      />

      {pendingDelete ? (
        <ConfirmDelete
          transaction={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}

      <AlertToaster toasts={alerts.toasts} onAck={alerts.markRead} />
    </>
  );
}

/** The date a new transaction should default to: today, or the month itself. */
function periodDefaults(period: Period): string {
  const today = currentPeriod();
  if (today.year === period.year && today.month === period.month) return new Date().toISOString().slice(0, 10);
  return `${String(period.year)}-${String(period.month).padStart(2, '0')}-01`;
}

function TabButton(props: {
  id: Tab;
  label: string;
  active: Tab;
  badge: number;
  onSelect: (tab: Tab) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="tab"
      role="tab"
      id={`tab-${props.id}`}
      aria-selected={props.active === props.id}
      aria-controls={`panel-${props.id}`}
      onClick={() => props.onSelect(props.id)}
    >
      {props.label}
      {props.badge > 0 ? <span className="badge badge--danger">{String(props.badge)}</span> : null}
    </button>
  );
}

function ConnectionControl(props: { status: string; onReconnect: () => void }): React.JSX.Element {
  if (props.status === 'open') {
    return (
      <span className="conn-dot" title="Real-time budget alerts are connected">
        <span className="conn-dot__circle conn-dot__circle--on" aria-hidden="true" />
        Live
      </span>
    );
  }
  return (
    <button type="button" className="conn-dot" onClick={props.onReconnect} title="Reconnect real-time alerts">
      <span className="conn-dot__circle conn-dot__circle--off" aria-hidden="true" />
      {props.status === 'connecting' ? 'Connecting…' : 'Reconnect'}
    </button>
  );
}

function MonthBar(props: { period: Period; onChange: (period: Period) => void }): React.JSX.Element {
  return (
    <div className="row">
      <span className="month-picker">
        <button
          type="button"
          className="icon-btn"
          onClick={() => props.onChange(shiftPeriod(props.period, -1))}
          aria-label="Previous month"
        >
          ←
        </button>
        <span className="month-picker__label" aria-live="polite">
          {formatMonth(props.period)}
        </span>
        <button
          type="button"
          className="icon-btn"
          onClick={() => props.onChange(shiftPeriod(props.period, 1))}
          aria-label="Next month"
        >
          →
        </button>
      </span>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => props.onChange(currentPeriod())}>
        Jump to current month
      </button>
    </div>
  );
}

function ConfirmDelete(props: { transaction: ApiTransaction; onCancel: () => void; onConfirm: () => void }): React.JSX.Element {
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && props.onCancel()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <div className="modal__head">
          <h2 id="confirm-title">Delete transaction?</h2>
        </div>
        <p>
          <strong>{props.transaction.title}</strong> will be removed permanently. Budget usage and alerts for that
          month are recalculated immediately.
        </p>
        <div className="modal__foot">
          <button type="button" className="btn btn--secondary" onClick={props.onCancel}>
            Keep it
          </button>
          <button type="button" className="btn btn--danger" onClick={props.onConfirm}>
            Delete transaction
          </button>
        </div>
      </div>
    </div>
  );
}
