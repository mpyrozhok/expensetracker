import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiAlert, ClientMessage, Period, ServerMessage } from '../lib/types.js';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export interface BudgetAlertChannel {
  status: ConnectionStatus;
  /** Every alert known for the subscribed month, newest first. */
  alerts: ApiAlert[];
  /** Alerts that arrived while connected and have not been dismissed. */
  toasts: ApiAlert[];
  unreadCount: number;
  dismiss: (id: string) => void;
  markRead: (threshold: number) => void;
  reconnect: () => void;
}

function parseMessage(text: string): ServerMessage | null {
  try {
    return JSON.parse(text) as ServerMessage;
  } catch {
    return null;
  }
}

function alertKey(alert: ApiAlert): string {
  return `${String(alert.period.year)}-${String(alert.period.month)}:${String(alert.threshold)}`;
}

/**
 * Budget alert socket.
 *
 * On open the client sends `subscribe` for the month it is looking at; that
 * message is what arms server-side delivery, and re-sending it when the month
 * picker changes re-arms it for the new period. `markRead` sends `ack`, which
 * the server confirms with `alert-read` and replays on the next subscribe.
 */
export function useBudgetAlerts(period: Period, enabled: boolean): BudgetAlertChannel {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [alerts, setAlerts] = useState<ApiAlert[]>([]);
  const [toasts, setToasts] = useState<ApiAlert[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const periodRef = useRef(period);
  const attemptRef = useRef(0);
  const closedByUsRef = useRef(false);

  periodRef.current = period;

  const send = useCallback((message: ClientMessage) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }, []);

  const subscribe = useCallback(() => {
    send({ type: 'subscribe', channel: 'budget_alerts', period: periodRef.current });
  }, [send]);

  useEffect(() => {
    if (!enabled) {
      setStatus('closed');
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    closedByUsRef.current = false;

    const connect = (): void => {
      setStatus('connecting');
      // Same document origin, so the proxy handles ws:// vs wss:// and the
      // session cookie is first-party.
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${scheme}//${window.location.host}/ws`);
      socketRef.current = socket;

      socket.onopen = () => {
        attemptRef.current = 0;
        setStatus('open');
        subscribe();
      };

      socket.onmessage = (event: MessageEvent<string>) => {
        const message = parseMessage(event.data);
        if (!message) return;
        if (message.type === 'budget-alerts') {
          const incoming = message.alerts.map((alert) => ({ ...alert }));
          setAlerts((previous) => mergeAlerts(previous, incoming, message.period));
          setToasts((previous) => {
            const fresh = incoming.filter((alert) => alert.new && !alert.read);
            if (fresh.length === 0) return previous;
            return [...fresh, ...previous].slice(0, 4);
          });
        }
        if (message.type === 'alert-read') {
          setAlerts((previous) =>
            previous.map((alert) =>
              alert.threshold === message.threshold && alert.period.year === message.period.year
                ? { ...alert, read: true }
                : alert,
            ),
          );
        }
      };

      socket.onclose = () => {
        setStatus('closed');
        socketRef.current = null;
        if (closedByUsRef.current) return;
        // Bounded exponential backoff: 1s, 2s, 4s, capped at 15s.
        const delay = Math.min(1000 * 2 ** attemptRef.current, 15000);
        attemptRef.current += 1;
        timer = setTimeout(connect, delay);
      };

      socket.onerror = () => {
        socket.close();
      };
    };

    connect();

    return () => {
      closedByUsRef.current = true;
      if (timer) clearTimeout(timer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [enabled, subscribe]);

  // Re-arm delivery whenever the visible month changes.
  useEffect(() => {
    subscribe();
  }, [subscribe, period.year, period.month]);

  const dismiss = useCallback((id: string) => {
    setToasts((previous) => previous.filter((alert) => alert.id !== id));
  }, []);

  const markRead = useCallback(
    (threshold: number) => {
      const periodNow = periodRef.current;
      send({ type: 'ack', channel: 'budget_alerts', period: periodNow, threshold });
      setAlerts((previous) =>
        previous.map((alert) => (alert.threshold === threshold ? { ...alert, read: true } : alert)),
      );
      setToasts((previous) => previous.filter((alert) => alert.threshold !== threshold));
    },
    [send],
  );

  const reconnect = useCallback(() => {
    socketRef.current?.close();
  }, []);

  const unreadCount = alerts.filter((alert) => !alert.read).length;

  return { status, alerts, toasts, unreadCount, dismiss, markRead, reconnect };
}

/** Ledger state replaces per-threshold entries; ordering is newest threshold first. */
function mergeAlerts(previous: ApiAlert[], incoming: ApiAlert[], period: Period): ApiAlert[] {
  const byKey = new Map<string, ApiAlert>();
  for (const alert of previous) {
    if (alert.period.year !== period.year || alert.period.month !== period.month) byKey.set(alertKey(alert), alert);
  }
  for (const alert of incoming) byKey.set(alertKey(alert), alert);
  return [...byKey.values()].sort((a, b) => b.threshold - a.threshold);
}
