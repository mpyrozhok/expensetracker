import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { loadConfig, type AppConfig } from './config.js';
import { openDb, type Db } from './db.js';
import { csrfGuard, loadUser } from './middleware.js';
import { OAuthError } from './oauth.js';
import { buildRouter } from './routes.js';
import { ApiError } from './validation.js';
import { createContext, type AppContext } from './context.js';
import { WS_PATH } from './ws/hub.js';
import type { FetchLike } from './oauth.js';
import type { ApiErrorBody } from './types.js';

export interface CreateAppOptions {
  config?: Partial<AppConfig>;
  db?: Db;
  /** Stub for the SSO providers' HTTP calls. Production uses global fetch. */
  fetchImpl?: FetchLike;
}

export interface CreatedApp {
  app: Express;
  ctx: AppContext;
  /** Releases the SQLite handle; call after closing the HTTP server. */
  close: () => void;
}

export function createApp(options: CreateAppOptions = {}): CreatedApp {
  const cfg = loadConfig(options.config ?? {});
  const ownsDb = options.db === undefined;
  const db = options.db ?? openDb(cfg.databasePath);
  const ctx = createContext({ cfg, db, fetchImpl: options.fetchImpl ?? globalThis.fetch });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(securityHeaders);
  app.use(loadUser(cfg, ctx.users));
  app.use('/api', csrfGuard);
  app.use('/api', buildRouter(ctx));

  if (cfg.staticDir) {
    // Production single-process mode: serve the built SPA and let it own unknown
    // paths, so one origin covers the API, /ws and the bundle. This must be
    // registered before the catch-all 404 handler, which would otherwise answer
    // every page request with a JSON error. API paths keep JSON semantics.
    const indexFile = path.join(cfg.staticDir, 'index.html');
    app.use(express.static(cfg.staticDir));
    app.get('*', (req: Request, res: Response, next: NextFunction) => {
      if (isApiPath(req.path) || req.path === WS_PATH) return next();
      return res.sendFile(indexFile);
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  const close = () => {
    ctx.hub.closeAll(1001, 'server shutdown');
    if (ownsDb) db.close();
  };

  return { app, ctx, close };
}

function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  next();
}

/** Paths owned by the JSON API; the SPA fallback must never answer for these. */
function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new ApiError('not_found', `No route for ${req.method} ${req.path}`, 404));
}

function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const body: ApiErrorBody = { error: { code: 'internal_error', message: 'Internal server error' } };

  if (err instanceof ApiError) {
    body.error = { code: err.code, message: err.message, details: err.details };
    res.status(err.status).json(body);
    return;
  }
  if (err instanceof OAuthError) {
    body.error = { code: err.code, message: err.message };
    res.status(err.status).json(body);
    return;
  }
  const shape = {
    type: String((err as Partial<ErrorShape>)?.type ?? ''),
    code: String((err as Partial<ErrorShape>)?.code ?? ''),
    statusCode: Number((err as Partial<ErrorShape>)?.statusCode ?? 0),
  };
  if (isBodyParseError(shape)) {
    body.error = { code: 'invalid_json', message: 'Request body must be valid JSON' };
    res.status(400).json(body);
    return;
  }
  if (isNotFoundError(shape)) {
    body.error = { code: 'not_found', message: 'Not found' };
    res.status(404).json(body);
    return;
  }

  logError(req, err as Error);
  res.status(500).json(body);
}

function isBodyParseError(err: ErrorShape): boolean {
  return err.type === 'entity.parse.failed' || err.type === 'entity.too.large';
}

function isNotFoundError(err: ErrorShape): boolean {
  return err.code === 'ENOENT' || err.statusCode === 404;
}

function logError(req: Request, err: Error): void {
  const message = String(err?.message ?? 'unknown error');
  process.stderr.write(`[error] ${req.method} ${req.originalUrl} ${message}${EOL}`);
}

const EOL = String.fromCharCode(10);

interface ErrorShape {
  type: string;
  code: string;
  statusCode: number;
}
