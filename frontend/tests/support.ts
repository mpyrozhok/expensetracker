import { vi } from 'vitest';

/** Test doubles shared by the frontend suites: fetch routing and a fake socket. */

export interface RecordedCall {
  method: string;
  path: string;
  query: string;
  body: Record<string, string | number | null> | null;
}

export type RouteHandler = (call: RecordedCall) => Response;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function errorResponse(code: string, message: string, status = 400): Response {
  return jsonResponse({ error: { code, message } }, status);
}

/** `/api/transactions/12?page=2` becomes `{ path: '/api/transactions/:id', ... }`. */
function parseCall(url: string, init: RequestInit | undefined): RecordedCall {
  const [withoutHash] = url.split('#');
  const [path, query = ''] = (withoutHash ?? url).split('?');
  const collapsed = (path ?? '').replace(/\/\d+$/g, '/:id');
  let body: Record<string, string | number | null> | null = null;
  if (typeof init?.body === 'string' && init.body !== '') {
    body = JSON.parse(init.body) as Record<string, string | number | null>;
  }
  return { method: (init?.method ?? 'GET').toUpperCase(), path: collapsed, query, body };
}

/**
 * Installs a fetch double that routes on `METHOD /path` (numeric ids collapsed to
 * `:id`) and records every call, so assertions can assert on the request the
 * component actually made rather than on internal state.
 */
export function installFetch(routes: Record<string, RouteHandler>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const missing = (call: RecordedCall): Response => {
    throw new Error(`unrouted fetch: ${call.method} ${call.path}${call.query}`);
  };
  const handler = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call = parseCall(String(input), init);
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`] ?? routes[call.method] ?? missing;
    return Promise.resolve(route(call));
  });
  vi.stubGlobal('fetch', handler);
  return calls;
}

/** Minimal WebSocket double: records sends, lets a test push frames. */
export class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];

  url: string;
  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  static latest(): FakeSocket {
    const last = FakeSocket.instances[FakeSocket.instances.length - 1];
    if (!last) throw new Error('no socket was constructed');
    return last;
  }

  /** Every frame of `type` sent by any socket, oldest first. */
  static sentOfType(type: string): Array<Record<string, unknown>> {
    return FakeSocket.instances.flatMap((socket) => socket.parsed().filter((frame) => frame.type === type));
  }

  parsed(): Array<Record<string, unknown>> {
    return this.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  }

  openSocket(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  push(message: Record<string, unknown>): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
  }

  closeSocket(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.closeSocket();
  }
}

export function installWebSocket(): void {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
}

export function lastSent(socket: FakeSocket, type: string): Record<string, unknown> {
  const frames = socket.parsed().filter((frame) => frame.type === type);
  const last = frames[frames.length - 1];
  if (!last) throw new Error(`no ${type} frame was sent`);
  return last;
}
