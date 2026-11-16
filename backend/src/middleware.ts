import type { NextFunction, Request, Response, RequestHandler } from 'express';
import type { AppConfig } from './config.js';
import { SESSION_COOKIE, extractSessionToken } from './session.js';
import { ApiError, unauthorized } from './validation.js';
import type { UsersService } from './services/users.js';
import type { UserRow } from './db.js';

export interface AuthedRequest extends Request {
  user?: UserRow;
}

type Handler = (req: AuthedRequest, res: Response, next: NextFunction) => Promise<void> | void;

/** Express 4 does not await async handlers; this adapter funnels rejections to the error middleware. */
export const wrap = (handler: Handler): RequestHandler => {
  const wrapped: RequestHandler = (req, res, next) => {
    void Promise.resolve(handler(req as AuthedRequest, res, next)).catch(next);
  };
  return wrapped;
};

/**
 * Resolves the session cookie (or an Authorization: Bearer token) to a user row.
 * Anonymous requests continue without a user; protected routes call requireUser.
 */
export const loadUser = (cfg: AppConfig, users: UsersService): RequestHandler => {
  const middleware: RequestHandler = (rawReq, _res, next) => {
    const req = rawReq as AuthedRequest;
    const claims = extractSessionToken(cfg, req);
    if (claims === null) return next();
    // findByClaims also applies revocation, so a token issued before the last
    // logout behaves as if it had never been presented.
    const user = users.findByClaims(claims);
    if (user) req.user = user;
    return next();
  };
  return middleware;
};

export function requireUser(req: AuthedRequest): UserRow {
  if (!req.user) throw unauthorized();
  return req.user;
}

/**
 * Cross-site request forgery defence for a cookie-session API: every state
 * changing call must carry this non-simple header, which a hostile cross-origin
 * form cannot set. The SPA client always sends it (frontend/src/lib/api.ts).
 */
export const CSRF_HEADER = 'X-Requested-With';
export const CSRF_HEADER_VALUE = 'expense-tracker';

export const csrfGuard: RequestHandler = (req, _res, next) => {
  const method = String(req.method).toUpperCase();
  const isRead = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  const header = Array.isArray(req.headers['x-requested-with'])
    ? req.headers['x-requested-with'][0]
    : req.headers['x-requested-with'];
  if (!isRead && String(header ?? '') !== CSRF_HEADER_VALUE) {
    next(
      new ApiError('csrf_header_missing', `Missing required ${CSRF_HEADER}: ${CSRF_HEADER_VALUE} header`, 403),
    );
    return;
  }
  next();
};

export function sessionCookieOptions(cfg: AppConfig) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    secure: cfg.cookieSecure,
    maxAge: cfg.sessionTtlSeconds * 1000,
  };
}

export function setSessionCookie(res: Response, cfg: AppConfig, token: string): void {
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions(cfg));
}

export function clearSessionCookie(res: Response, cfg: AppConfig): void {
  res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(cfg), maxAge: 0 });
}
