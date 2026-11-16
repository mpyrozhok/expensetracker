import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import type { AppConfig } from '../config.js';
import type { AlertService } from '../services/alerts.js';
import type { UsersService } from '../services/users.js';
import { extractSessionToken } from '../session.js';
import {
  BUDGET_ALERT_THRESHOLDS,
  type Period,
  type ServerMessage,
} from '../types.js';

export const BUDGET_ALERTS_CHANNEL = 'budget_alerts';
export const WS_PATH = '/ws';

/** Wire envelope; every field is optional here and re-validated per message type. */
interface InboundMessage {
  type?: string;
  channel?: string;
  period?: Period;
  threshold?: number;
}

interface Client {
  id: number;
  socket: WebSocket;
  userId: number;
  subscription: { period: Period } | null;
}

/**
 * WebSocket fan-out for budget alerts.
 *
 * Two-way protocol (documented in README):
 *   client → server: subscribe | unsubscribe | ack | ping
 *   server → client: welcome | subscription | budget-alerts | alert-read | pong | error
 *
 * `subscribe` is the meaningful client → server message: the server only ever
 * pushes alerts for a period the socket explicitly subscribed to, and a
 * subscribe both (a) arms evaluation for that period and (b) replays the ledger
 * so the client sees which thresholds already fired this month.
 * `ack` marks an alert read and is confirmed with `alert-read`.
 *
 * Authorization: the upgrade request must carry the same session credential as
 * the HTTP API; unauthenticated sockets are closed with code 4401 before any
 * application frame is sent, and every socket only ever receives alerts
 * computed for its own user id.
 */
export class BudgetHub {
  private readonly wss: WebSocketServer;
  private readonly clients = new Map<number, Client>();
  private nextClientId = 1;

  constructor(
    private readonly cfg: AppConfig,
    private readonly alerts: AlertService,
    private readonly users: UsersService,
  ) {
    this.wss = new WebSocketServer({ noServer: true, path: WS_PATH });
  }

  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => {
      if (requestPath(req) !== WS_PATH) return;
      // Same credential and the same revocation rule as the HTTP API, so a
      // socket cannot outlive the session that opened it.
      const claims = extractSessionToken(this.cfg, req);
      const user = claims === null ? null : this.users.findByClaims(claims);
      if (user === null) {
        socket.write('HTTP/1.1 4401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.onConnect(ws, user.id);
      });
    });
  }

  get connectionCount(): number {
    return this.clients.size;
  }

  subscriptionsFor(userId: number): Period[] {
    const periods: Period[] = [];
    for (const client of this.clients.values()) {
      if (client.userId === userId && client.subscription) periods.push(client.subscription.period);
    }
    return periods;
  }

  /**
   * Called after any transaction/budget mutation. Evaluates only periods that
   * at least one socket of this user has subscribed to; alerts that are new in
   * the ledger are pushed to those sockets.
   */
  notifyBudgetChange(userId: number, period: Period): void {
    const targets = this.clientsOf(userId, period);
    if (targets.length === 0) return;
    const evaluation = this.alerts.evaluate(userId, period);
    if (!evaluation || evaluation.fresh.length === 0) return;
    const alerts = this.alerts
      .toAlerts(userId, evaluation)
      .filter((alert) => evaluation.fresh.includes(alert.threshold));
    for (const client of targets) send(client.socket, { type: 'budget-alerts', period, alerts });
  }

  closeAll(code = 1001, reason = 'server shutdown'): void {
    for (const client of this.clients.values()) client.socket.close(code, reason);
    this.clients.clear();
    this.wss.close();
  }

  private onConnect(socket: WebSocket, userId: number): void {
    const client: Client = { id: this.nextClientId++, socket, userId, subscription: null };
    this.clients.set(client.id, client);

    send(socket, { type: 'welcome', server_time: new Date().toISOString(), user_id: userId });

    socket.on('message', (raw) => {
      let parsed: InboundMessage | null = null;
      try {
        parsed = JSON.parse(String(raw)) as InboundMessage;
      } catch {
        send(socket, { type: 'error', code: 'invalid_json', message: 'Message is not valid JSON' });
        return;
      }
      this.onMessage(client, parsed);
    });

    socket.on('close', () => {
      this.clients.delete(client.id);
    });
    socket.on('error', () => {
      this.clients.delete(client.id);
    });
  }

  private onMessage(client: Client, parsed: InboundMessage | null): void {
    const message: InboundMessage = parsed ?? {};
    switch (message.type) {
      case 'ping':
        send(client.socket, { type: 'pong', server_time: new Date().toISOString() });
        return;
      case 'subscribe':
        this.onSubscribe(client, message);
        return;
      case 'unsubscribe':
        client.subscription = null;
        send(client.socket, { type: 'unsubscribed', channel: BUDGET_ALERTS_CHANNEL });
        return;
      case 'ack':
        this.onAck(client, message);
        return;
      default:
        send(client.socket, {
          type: 'error',
          code: 'unknown_message_type',
          message: 'Unsupported message type; expected subscribe, unsubscribe, ack or ping',
        });
    }
  }

  private onSubscribe(client: Client, message: InboundMessage): void {
    if (String(message.channel ?? '') !== BUDGET_ALERTS_CHANNEL) {
      send(client.socket, { type: 'error', code: 'unknown_channel', message: 'channel must be budget_alerts' });
      return;
    }
    const period = normalizePeriod(message.period);
    if (!period) {
      send(client.socket, { type: 'error', code: 'period_invalid', message: 'period must be {year, month}' });
      return;
    }

    client.subscription = { period };
    send(client.socket, { type: 'subscription', channel: BUDGET_ALERTS_CHANNEL, period, ok: true });

    // Alert generation point #1: the connection/subscription just opened.
    const evaluation = this.alerts.evaluate(client.userId, period);
    if (!evaluation) {
      // No budget for this month: explicit empty state, never misleading numbers.
      send(client.socket, { type: 'budget-alerts', period, alerts: [] });
      return;
    }
    send(client.socket, { type: 'budget-alerts', period, alerts: this.alerts.toAlerts(client.userId, evaluation) });
  }

  private onAck(client: Client, message: InboundMessage): void {
    if (String(message.channel ?? '') !== BUDGET_ALERTS_CHANNEL) {
      send(client.socket, { type: 'error', code: 'unknown_channel', message: 'channel must be budget_alerts' });
      return;
    }
    const period = normalizePeriod(message.period);
    const threshold = normalizeThreshold(message.threshold);
    if (!period || threshold === null) {
      send(client.socket, {
        type: 'error',
        code: 'alert_invalid',
        message: 'ack requires a valid period and a threshold of 50, 80 or 100',
      });
      return;
    }
    // Durable: the ack is a row update, so the threshold stays acknowledged
    // across reconnects and server restarts, not just in this socket's memory.
    this.alerts.markRead(client.userId, period, threshold);
    const confirmation: ServerMessage = {
      type: 'alert-read',
      channel: BUDGET_ALERTS_CHANNEL,
      period,
      threshold,
    };
    send(client.socket, confirmation);
    // Any other tab of the same user that is watching this period clears the
    // alert too, so two windows do not disagree about what is still unread.
    for (const other of this.clientsOf(client.userId, period)) {
      if (other.id !== client.id) send(other.socket, confirmation);
    }
  }

  private clientsOf(userId: number, period: Period): Client[] {
    const hits: Client[] = [];
    for (const client of this.clients.values()) {
      const sub = client.subscription;
      if (client.userId === userId && sub && samePeriod(sub.period, period)) hits.push(client);
    }
    return hits;
  }
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function requestPath(req: IncomingMessage): string {
  const raw = req.url ?? '';
  const qmark = raw.indexOf('?');
  return qmark === -1 ? raw : raw.slice(0, qmark);
}

/** Query-string/JSON values are coerced, never trusted, and validated by range. */
function normalizePeriod(value: Period | undefined | null): Period | null {
  const year = Number(value?.year);
  const month = Number(value?.month);
  if (!Number.isInteger(year) || year < 1970 || year > 2200) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  return { year, month };
}

function normalizeThreshold(value: number | undefined | null): number | null {
  const threshold = Number(value);
  const hit = BUDGET_ALERT_THRESHOLDS.find((t) => t === threshold);
  return hit === undefined ? null : hit;
}

function samePeriod(a: Period, b: Period): boolean {
  return a.year === b.year && a.month === b.month;
}
