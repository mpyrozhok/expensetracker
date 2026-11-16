import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { AppConfig } from './config.js';

export const SESSION_COOKIE = 'et_session';

interface SessionPayload {
  uid: number;
  /** Session generation this token was minted in; see UsersService.findByClaims. */
  epoch: number;
  exp: number;
}

function sign(secret: string, data: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

export function createSessionToken(
  secret: string,
  userId: number,
  ttlSeconds: number,
  epoch = 0,
): string {
  const payload: SessionPayload = {
    uid: userId,
    epoch,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

/**
 * What a verified token asserts. `epoch` is the session generation: bumping it
 * (on logout) invalidates every previously issued token for that user.
 */
export interface SessionClaims {
  uid: number;
  epoch: number;
}

interface UserPayload {
  uid?: number;
  epoch?: number;
  exp?: number;
}

function numField(value: number | undefined): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}

export function verifySessionToken(secret: string, token: string | undefined): SessionClaims | null {
  if (!token || !secret) return null;
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  const expected = sign(secret, body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload: UserPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as UserPayload;
  } catch {
    return null;
  }
  const uid = numField(payload.uid);
  const exp = numField(payload.exp);
  if (uid === undefined || exp === undefined) return null;
  if (exp < Math.floor(Date.now() / 1000)) return null;
  // Tokens minted before epochs existed count as generation 0, which matches a
  // user who has never logged out.
  return { uid, epoch: numField(payload.epoch) ?? 0 };
}

export function cookieSessionCookie(header: string | undefined, name = SESSION_COOKIE): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return undefined;
}

type HeaderLike = { headers: Record<string, string | string[] | undefined> };

function headerValue(header: string | string[] | undefined): string | undefined {
  return Array.isArray(header) ? header[0] : header;
}

/** Extracts the session credential from the Cookie header or an Authorization: Bearer header. */
export function extractSessionToken(
  cfg: AppConfig,
  req: IncomingMessage | HeaderLike,
): SessionClaims | null {
  const auth = headerValue(req.headers.authorization);
  if (auth && auth.startsWith('Bearer ')) {
    return verifySessionToken(cfg.sessionSecret, auth.slice(7).trim());
  }
  return verifySessionToken(cfg.sessionSecret, cookieSessionCookie(headerValue(req.headers.cookie)));
}
