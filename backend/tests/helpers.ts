import http from 'node:http';
import { WebSocket } from 'ws';
import type { Express } from 'express';
import request from 'supertest';
import { createApp, type CreatedApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import type { FetchLike } from '../src/oauth.js';
import { createSessionToken } from '../src/session.js';
import type { OAuthProviderConfig, ProviderName } from '../src/config.js';
import type { Period, ServerMessage } from '../src/types.js';

/**
 * Provider credentials for the offline OAuth tests. The URLs are the real
 * Google/GitHub endpoints so the authorize redirect is exercised for real,
 * while the token/userinfo exchanges are answered by the injected stub fetch —
 * nothing here can reach the network.
 */
export function stubProviders(): Record<ProviderName, OAuthProviderConfig> {
  return {
    google: {
      clientId: 'stub-google.apps.example.com',
      clientSecret: 'stub-google-secret',
      redirectUri: 'http://localhost:8787/api/auth/google/callback',
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
      scopes: ['openid', 'profile', 'email'],
    },
    github: {
      clientId: 'stub-github-client',
      clientSecret: 'stub-github-secret',
      redirectUri: 'http://localhost:8787/api/auth/github/callback',
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      userInfoUrl: 'https://api.github.com/user',
      scopes: ['read:user', 'user:email'],
    },
  };
}

export const CSRF = { 'X-Requested-With': 'expense-tracker' };

export interface TestApp extends CreatedApp {
  api: TestClient;
}

/** Cookie-aware client that always sends the CSRF header, like the SPA does. */
export interface TestClient {
  get: (url: string) => request.Test;
  post: (url: string) => request.Test;
  put: (url: string) => request.Test;
  del: (url: string) => request.Test;
  login: (user: string, provider?: 'google' | 'github') => Promise<request.Response>;
  userId: () => number;
  token: () => string;
}

export interface TestEnvOptions {
  config?: Partial<AppConfig>;
  fetchImpl?: FetchLike;
}

/**
 * One isolated app per test: a private in-memory SQLite database, mock SSO
 * enabled, and no provider credentials, so nothing can reach Google/GitHub.
 */
export function testEnv(options: TestEnvOptions = {}): TestApp {
  const created = createApp({
    ...options,
    config: { databasePath: ':memory:', providers: stubProviders(), ...options.config },
  });
  const app = created.app as Express;
  const agent = request.agent(app);

  let userId = 0;
  let token = '';

  const withCsrf = (call: request.Test) => call.set(CSRF);

  const api: TestClient = {
    get: (url) => agent.get(url),
    post: (url) => withCsrf(agent.post(url)),
    put: (url) => withCsrf(agent.put(url)),
    del: (url) => withCsrf(agent.delete(url)),
    login: async (user, provider = 'google') => {
      const res = await withCsrf(agent.post('/api/auth/mock/login')).send({ provider, mock_user: user });
      if (res.status !== 200) throw new Error(`mock login failed: ${res.status} ${JSON.stringify(res.body)}`);
      userId = Number(res.body.user.id);
      token = createSessionToken(created.ctx.cfg.sessionSecret, userId, created.ctx.cfg.sessionTtlSeconds);
      return res;
    },
    userId: () => userId,
    token: () => token,
  };

  return { ...created, api };
}

/** A running HTTP server + WebSocket endpoint, for the real-time tests. */
export interface LiveApp extends TestApp {
  server: http.Server;
  url: string;
  wsUrl: string;
  closeLive: () => Promise<void>;
}

export async function liveApp(options: TestEnvOptions = {}): Promise<LiveApp> {
  const base = testEnv(options);
  const server = http.createServer(base.app);
  base.ctx.hub.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;
  return {
    ...base,
    server,
    url,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    closeLive: async () => {
      base.ctx.hub.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      base.close();
    },
  };
}

/** ISO date (UTC) offset from today; used for date-range filters. */
export function isoDate(offsetDays: number, now = new Date()): string {
  const d = new Date(now.getTime());
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

export function currentPeriod(now = new Date()): { year: number; month: number } {
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

/** A day-of-month inside the current calendar month (the period alerts track). */
export function dayInCurrentMonth(day: number, now = new Date()): string {
  const { year, month } = currentPeriod(now);
  const lastDay = new Date(year, month, 0).getDate();
  const safe = Math.min(Math.max(day, 1), lastDay);
  return `${year}-${String(month).padStart(2, '0')}-${String(safe).padStart(2, '0')}`;
}

export type MessageFilter = (message: ServerMessage) => boolean;

/**
 * Test WebSocket client. Messages are buffered from arrival, so a test can
 * assert on frames the server pushed before the test started waiting — the
 * same race the real client avoids by subscribing once and listening forever.
 */
export class TestSocket {
  readonly socket: WebSocket;
  readonly messages: ServerMessage[] = [];
  private readonly waiters: { match: MessageFilter; resolve: (m: ServerMessage) => void }[] = [];
  private closeError: Error | null = null;

  constructor(url: string, token?: string, cookie?: string) {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (cookie) headers.cookie = cookie;
    this.socket = new WebSocket(url, Object.keys(headers).length > 0 ? { headers } : undefined);
    this.socket.on('message', (raw) => this.ingest(String(raw)));
    this.socket.on('error', (err) => {
      this.closeError = err;
    });
  }

  get closed(): boolean {
    return this.socket.readyState === WebSocket.CLOSED || this.socket.readyState === WebSocket.CLOSING;
  }

  private ingest(text: string): void {
    const message = JSON.parse(text) as ServerMessage;
    this.messages.push(message);
    for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.waiters[i];
      if (waiter && waiter.match(message)) {
        this.waiters.splice(i, 1);
        waiter.resolve(message);
      }
    }
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('error', (err) => reject(err));
    });
  }

  send(message: object): void {
    this.socket.send(JSON.stringify(message));
  }

  subscribe(period: Period): void {
    this.send({ type: 'subscribe', channel: 'budget_alerts', period });
  }

  waitForType(type: ServerMessage['type'], timeoutMs = 4000, fromIndex = 0): Promise<ServerMessage> {
    return this.waitFor((m) => m.type === type, timeoutMs, fromIndex);
  }

  alerts(): Extract<ServerMessage, { type: 'budget-alerts' }>[] {
    return this.messages.filter(
      (m): m is Extract<ServerMessage, { type: 'budget-alerts' }> => m.type === 'budget-alerts',
    );
  }

  firedThresholds(): number[] {
    const out: number[] = [];
    for (const frame of this.alerts()) {
      for (const alert of frame.alerts) if (alert.new) out.push(alert.threshold);
    }
    return out;
  }

  waitFor(match: MessageFilter, timeoutMs = 4000, fromIndex = 0): Promise<ServerMessage> {
    const existing = this.messages.slice(fromIndex).find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no matching frame within ${timeoutMs}ms; got ${JSON.stringify(this.messages)}`));
      }, timeoutMs);
      this.waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  closedPromise(): Promise<Error | null> {
    return new Promise((resolve) => {
      if (this.closeError) return resolve(this.closeError);
      if (this.closed) return resolve(null);
      this.socket.once('error', (err) => resolve(err));
      this.socket.once('close', () => resolve(null));
    });
  }

  close(): void {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
  }
}

/** Lets the event loop drain so any frame the server did not send cannot be mistaken for "not yet". */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
