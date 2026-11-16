import type { ApiAlert } from '../lib/types.js';
import { formatMoney, formatMonth } from '../lib/format.js';
import type { ConnectionStatus } from '../hooks/useBudgetAlerts.js';
import { EmptyState } from './ui.js';

export function alertHeadline(alert: ApiAlert): string {
  if (alert.threshold === 100) return `Budget reached — ${formatMonth(alert.period)}`;
  return `${String(alert.threshold)}% of budget used — ${formatMonth(alert.period)}`;
}

export function alertBody(alert: ApiAlert): string {
  return `${formatMoney(alert.spent, alert.currency)} of ${formatMoney(alert.budget, alert.currency)} spent (${Math.round(alert.usage_percent)}%).`;
}

function AlertRow(props: { alert: ApiAlert; onAck: (threshold: number) => void; tone: 'panel' | 'toast' }): React.JSX.Element {
  const { alert } = props;
  const classes = ['alert', `alert--${String(alert.threshold)}`];
  if (alert.read) classes.push('alert--read');
  return (
    <div className={classes.join(' ')} role={props.tone === 'toast' ? 'status' : 'listitem'}>
      <span aria-hidden="true">{alert.threshold === 100 ? '🚨' : '📊'}</span>
      <span className="alert__copy">
        <span className="alert__title">{alertHeadline(alert)}</span>
        <span className="alert__body">{alertBody(alert)}</span>
      </span>
      {alert.read ? (
        <span className="badge">read</span>
      ) : (
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => props.onAck(alert.threshold)}>
          Mark read
        </button>
      )}
    </div>
  );
}

export function AlertsPanel(props: {
  alerts: ApiAlert[];
  status: ConnectionStatus;
  onAck: (threshold: number) => void;
  periodLabel: string;
}): React.JSX.Element {
  return (
    <section className="card" aria-labelledby="alerts-heading">
      <div className="card__head">
        <h2 id="alerts-heading">Budget alerts</h2>
        <span className="spacer" />
        <ConnectionBadge status={props.status} />
      </div>
      {props.alerts.length === 0 ? (
        <EmptyState
          icon="🔔"
          title="No alerts for this month"
          body={`Thresholds are checked at 50%, 80% and 100% of the ${props.periodLabel} budget. Nothing to report yet.`}
        />
      ) : (
        <div className="alerts" role="list">
          {props.alerts.map((alert) => (
            <AlertRow key={alert.id} alert={alert} onAck={props.onAck} tone="panel" />
          ))}
        </div>
      )}
    </section>
  );
}

/** Toast stack: what arrived while the socket was open. */
export function AlertToaster(props: { toasts: ApiAlert[]; onAck: (threshold: number) => void }): React.JSX.Element | null {
  if (props.toasts.length === 0) return null;
  return (
    <div className="toasts" aria-live="assertive">
      {props.toasts.map((alert) => (
        <AlertRow key={alert.id} alert={alert} onAck={props.onAck} tone="toast" />
      ))}
    </div>
  );
}

export function ConnectionBadge({ status }: { status: ConnectionStatus }): React.JSX.Element {
  const labels: Record<ConnectionStatus, string> = {
    connecting: 'Connecting…',
    open: 'Live',
    closed: 'Offline',
  };
  const dot = status === 'open' ? 'conn-dot__circle conn-dot__circle--on' : 'conn-dot__circle conn-dot__circle--off';
  return (
    <span className="conn-dot" title="Real-time budget alert connection">
      <span className={dot} aria-hidden="true" />
      {labels[status]}
    </span>
  );
}
