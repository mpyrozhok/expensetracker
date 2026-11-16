// @vitest-environment jsdom
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { useBudgetAlerts } from '../src/hooks/useBudgetAlerts.js';
import type { ApiAlert, Period } from '../src/lib/types.js';
import { alert as alertFixture } from './fixtures.js';
import { FakeSocket, installWebSocket, lastSent } from './support.js';

const period: Period = { year: 2026, month: 3 };
const MARCH: Period = { year: 2026, month: 3 };
const FEBRUARY: Period = { year: 2026, month: 2 };

function marchAlert(overrides: Partial<ApiAlert> = {}): ApiAlert {
  return alertFixture({ period: MARCH, ...overrides });
}

function frame(periodValue: Period, alerts: ApiAlert[]): Record<string, unknown> {
  return { type: 'budget-alerts', channel: 'budget_alerts', period: periodValue, alerts };
}

/** Ledger snapshot the backend sends on subscribe: 50% new, 80% already read. */
function ledgerFrame(): Record<string, unknown> {
  return frame(MARCH, [marchAlert({ threshold: 50, new: true }), marchAlert({ threshold: 80, new: false, read: true })]);
}

function Harness(props: { period: Period }): React.JSX.Element {
  const channel = useBudgetAlerts(props.period, true);
  return (
    <div>
      <span data-testid="status">{channel.status}</span>
      <span data-testid="unread">{String(channel.unreadCount)}</span>
      <ul>
        {channel.alerts.map((item) => (
          <li key={item.id}>
            {item.id}:{item.read ? 'read' : 'unread'}
          </li>
        ))}
      </ul>
      <div data-testid="toasts">
        {channel.toasts.map((item) => (
          <p key={item.id}>toast {String(item.threshold)}</p>
        ))}
      </div>
      <button type="button" onClick={() => channel.markRead(50)}>
        mark 50 read
      </button>
      <button type="button" onClick={() => channel.dismiss('budget-alert:2026-3:50')}>
        dismiss toast
      </button>
    </div>
  );
}

function openSocket(): FakeSocket {
  const socket = FakeSocket.latest();
  act(() => socket.openSocket());
  return socket;
}

describe('useBudgetAlerts', () => {
  it('subscribes to the visible month as soon as the socket opens', () => {
    installWebSocket();
    render(<Harness period={period} />);

    // Opening is asynchronous: the client must not assume it is live yet.
    expect(screen.getByTestId('status')).toHaveTextContent('connecting');

    const socket = openSocket();
    expect(screen.getByTestId('status')).toHaveTextContent('open');
    expect(lastSent(socket, 'subscribe')).toMatchObject({
      type: 'subscribe',
      channel: 'budget_alerts',
      period,
    });
  });

  it('re-arms the subscription when the visible month changes', () => {
    installWebSocket();
    const { rerender } = render(<Harness period={period} />);
    const socket = openSocket();

    rerender(<Harness period={FEBRUARY} />);

    expect(lastSent(socket, 'subscribe')).toMatchObject({ period: FEBRUARY });
  });

  it('renders replayed alerts and only toasts the ones the server marks new', () => {
    installWebSocket();
    render(<Harness period={period} />);
    const socket = openSocket();

    act(() => socket.push(ledgerFrame()));

    expect(screen.getByText('budget-alert:2026-3:50:unread')).toBeInTheDocument();
    expect(screen.getByText('budget-alert:2026-3:80:read')).toBeInTheDocument();
    expect(screen.getByTestId('unread')).toHaveTextContent('1');
    expect(screen.getByTestId('toasts')).toHaveTextContent('toast 50');
    expect(screen.queryByText('toast 80')).not.toBeInTheDocument();
  });

  it('sends an ack on mark-read and reflects it locally at once', async () => {
    installWebSocket();
    render(<Harness period={period} />);
    const socket = openSocket();
    act(() => socket.push(ledgerFrame()));

    await userEvent.click(screen.getByRole('button', { name: /mark 50 read/i }));

    expect(lastSent(socket, 'ack')).toMatchObject({
      type: 'ack',
      channel: 'budget_alerts',
      period,
      threshold: 50,
    });
    expect(screen.getByText('budget-alert:2026-3:50:read')).toBeInTheDocument();
    expect(screen.getByTestId('toasts')).toBeEmptyDOMElement();
  });

  it('marks read when the server confirms another tab acknowledged it', () => {
    installWebSocket();
    render(<Harness period={period} />);
    const socket = openSocket();
    act(() => socket.push(ledgerFrame()));

    act(() => socket.push({ type: 'alert-read', channel: 'budget_alerts', period, threshold: 50 }));

    expect(screen.getByText('budget-alert:2026-3:50:read')).toBeInTheDocument();
    expect(screen.getByTestId('unread')).toHaveTextContent('0');
  });

  it('dismisses a toast without acknowledging the threshold', async () => {
    installWebSocket();
    render(<Harness period={period} />);
    const socket = openSocket();
    act(() => socket.push(ledgerFrame()));

    await userEvent.click(screen.getByRole('button', { name: /dismiss toast/i }));

    expect(screen.getByTestId('toasts')).toBeEmptyDOMElement();
    // Dismissal is presentation only: the alert stays unread until it is acked,
    // and will be replayed on the next subscribe.
    expect(screen.getByText('budget-alert:2026-3:50:unread')).toBeInTheDocument();
    expect(FakeSocket.sentOfType('ack')).toHaveLength(0);
  });

  /**
   * Contract from the server: each snapshot is the complete ledger for the month
   * it covers, so a threshold missing from it is no longer fired. A client that
   * accumulated forever would keep showing alerts the backend has dropped.
   */
  it('treats each snapshot as the whole ledger for its month', () => {
    installWebSocket();
    render(<Harness period={period} />);
    const socket = openSocket();
    act(() => socket.push(ledgerFrame()));

    act(() => socket.push(frame(MARCH, [marchAlert({ threshold: 100, new: true })])));

    expect(screen.getByText('budget-alert:2026-3:100:unread')).toBeInTheDocument();
    expect(screen.queryByText(/2026-3:50/)).not.toBeInTheDocument();
    expect(screen.queryByText(/2026-3:80/)).not.toBeInTheDocument();
  });

  it('leaves alerts for other months untouched', () => {
    installWebSocket();
    render(<Harness period={period} />);
    const socket = openSocket();
    act(() =>
      socket.push(
        frame(FEBRUARY, [marchAlert({ id: 'budget-alert:2026-2:50', threshold: 50, period: FEBRUARY, read: true })]),
      ),
    );

    act(() => socket.push(ledgerFrame()));

    expect(screen.getByText('budget-alert:2026-2:50:read')).toBeInTheDocument();
    expect(screen.getByText('budget-alert:2026-3:50:unread')).toBeInTheDocument();
    expect(screen.getByText('budget-alert:2026-3:80:read')).toBeInTheDocument();
  });

  it('ignores a malformed frame instead of crashing the app', () => {
    installWebSocket();
    render(<Harness period={period} />);
    const socket = openSocket();

    act(() => {
      socket.onmessage?.(new MessageEvent('message', { data: '{not json' }));
    });

    expect(screen.getByTestId('status')).toHaveTextContent('open');
  });

  it('reports a closed socket and reconnects with backoff', () => {
    vi.useFakeTimers();
    installWebSocket();
    render(<Harness period={period} />);
    const first = openSocket();

    act(() => first.closeSocket());
    expect(screen.getByTestId('status')).toHaveTextContent('closed');

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(FakeSocket.instances).toHaveLength(2);
    expect(screen.getByTestId('status')).toHaveTextContent('connecting');
    vi.useRealTimers();
  });

  it('backs off further on each consecutive failure', () => {
    vi.useFakeTimers();
    installWebSocket();
    render(<Harness period={period} />);
    const first = openSocket();
    act(() => first.closeSocket());

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(FakeSocket.instances).toHaveLength(2);
    act(() => {
      FakeSocket.instances[1]?.closeSocket();
    });

    // The second attempt waits 2s rather than starting over at 1s.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(FakeSocket.instances).toHaveLength(2);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(FakeSocket.instances).toHaveLength(3);
    vi.useRealTimers();
  });

  it('stops retrying once the component unmounts', () => {
    vi.useFakeTimers();
    installWebSocket();
    const { unmount } = render(<Harness period={period} />);
    const socket = openSocket();
    unmount();

    act(() => socket.closeSocket());
    act(() => {
      vi.advanceTimersByTime(60000);
    });

    expect(FakeSocket.instances).toHaveLength(1);
    vi.useRealTimers();
  });

  it('sends nothing while the socket is not open', () => {
    installWebSocket();
    const { result } = renderHook(() => useBudgetAlerts(period, true));

    act(() => result.current.markRead(80));

    expect(FakeSocket.latest().sent).toHaveLength(0);
  });

  it('ignores a welcome frame that carries no alerts', async () => {
    installWebSocket();
    const { result } = renderHook(() => useBudgetAlerts(period, true));
    const socket = FakeSocket.latest();
    act(() => socket.openSocket());

    act(() => socket.push({ type: 'welcome', server_time: '2026-03-01T00:00:00.000Z' }));

    await waitFor(() => expect(result.current.status).toBe('open'));
    expect(result.current.alerts).toHaveLength(0);
  });
});
