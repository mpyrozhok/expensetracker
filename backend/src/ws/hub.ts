import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { AppConfig } from '../config.js';
import type { AlertService } from '../services/alerts.js';
import type { UsersService } from '../services/users.js';
import { originBelongsToApp } from '../middleware.js';
import { isCurrentPeriod } from '../clock.js';
import { extractSessionToken } from '../session.js';
import {
  BUDGET_ALERT_THRESHOLDS,
  type ApiAlert,
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
 * subscribe both (a) arms evaluation when that period is the current calendar
 * month - the only month alerts are calculated for - and (b) replays the ledger
 * so the client sees which thresholds already fired there.
 * `ack` marks an alert read and is confirmed with `alert-read`.
 *
 * Authorization: the upgrade request must carry the same session credential as
 * the HTTP API, and a socket that fails it is refused before any application
 * frame is sent (see refuseUpgrade for why that is a plain HTTP status). Every
 * socket only ever receives alerts computed for its own user id.
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
      // A browser always sends Origin on a WebSocket upgrade, and it attaches the
      // session cookie automatically - so without this check a page on another
      // site could open a socket into a signed-in user's alerts. Non-browser
      // clients (tests, the smoke script, CLI tools) send no Origin and stay
      // allowed, because for them there is no cross-site model to enforce.
      const origin = headerValue(req.headers.origin);
      if (origin !== null && !originBelongsToApp(this.cfg, origin)) {
        refuseUpgrade(socket, 403, 4403, 'origin_not_allowed');
        return;
      }
      // Same credential and the same revocation rule as the HTTP API, so a
      // socket cannot outlive the session that opened it.
      const claims = extractSessionToken(this.cfg, req);
      const user = claims === null ? null : this.users.findByClaims(claims);
      if (user === null) {
        refuseUpgrade(socket, 401, 4401, 'unauthorized');
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
   * at least one socket of this user has subscribed to; when something is new
   * in the ledger, the period's FULL alert list is pushed to those sockets.
   *
   * The frame must be the whole ledger, not just the fresh entry: the client
   * treats each frame as the period's complete state and replaces its entries
   * with it, so a partial frame would silently drop the thresholds that fired
   * earlier in the same session (the 50% row vanishing once 80% crossed).
   * Freshness rides on the `new` flag, which the client uses for toasts.
   */
  notifyBudgetChange(userId: number, period: Period): void {
    const targets = this.clientsOf(userId, period);
    if (targets.length === 0) return;
    const evaluation = this.alerts.evaluate(userId, period);
    if (!evaluation || evaluation.fresh.length === 0) return;
    const alerts = this.alerts.toAlerts(userId, evaluation);
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

    // Handlers first, welcome second. `ws` emits an incoming frame to whichever
    // listeners exist at that moment, so a client that replies the instant it
    // sees `welcome` - which is exactly what a subscribe-on-open client does -
    // would otherwise have that first message silently dropped.
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

    send(socket, { type: 'welcome', server_time: new Date().toISOString(), user_id: userId });
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

    // Alert generation point #1: the subscription just opened - for the current
    // calendar month only. A socket may subscribe to any month the user is
    // browsing, and evaluating one of those would record threshold crossings
    // after the fact, which is what the once-per-threshold-per-month rule is
    // protecting. Any other period replays whatever its ledger already holds.
    const alerts = isCurrentPeriod(period)
      ? this.generatedAlerts(client.userId, period)
      : this.alerts.recorded(client.userId, period);
    send(client.socket, { type: 'budget-alerts', period, alerts });
  }

  /** Evaluate the month alerts are calculated for; no budget means no alerts. */
  private generatedAlerts(userId: number, period: Period): ApiAlert[] {
    const evaluation = this.alerts.evaluate(userId, period);
    return evaluation ? this.alerts.toAlerts(userId, evaluation) : [];
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

function headerValue(raw: string | string[] | undefined): string | null {
  if (Array.isArray(raw)) return raw[0] ?? null;
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

/**
 * Turn an upgrade request down before a WebSocket exists.
 *
 * The status line has to be a real three-digit HTTP status. Writing the
 * four-digit WebSocket close code (4401) there - which is what this used to do -
 * produces a response no client can parse: the browser reports an opaque
 * handshake failure, the network tab shows nothing useful, and a proxy in the
 * middle may log a bad gateway. So the refusal is an ordinary HTTP response and
 * the close-code equivalent rides along in a header for clients that care about
 * the distinction between "sign in" and "that page may not connect here".
 */
const REFUSAL_PHRASES: Record<number, string> = { 401: 'Unauthorized', 403: 'Forbidden' };

function refuseUpgrade(socket: Duplex, status: number, closeCode: number, reason: string): void {
  socket.end(
    `HTTP/1.1 ${status} ${REFUSAL_PHRASES[status] ?? 'Forbidden'}\r\n` +
      `X-WebSocket-Reject: ${closeCode} ${reason}\r\n` +
      'Content-Length: 0\r\n' +
      'Connection: close\r\n' +
      '\r\n',
  );
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
