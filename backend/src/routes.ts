import { Router } from 'express';
import type { Response } from 'express';
import type { AppContext } from './context.js';
import type { BudgetBody, CategoryBody, MockLoginBody, QueryString, TransactionBody } from './bodies.js';
import { clearSessionCookie, requireUser, setSessionCookie, wrap, type AuthedRequest } from './middleware.js';
import { redirectAllowlisted } from './redirect.js';
import {
  buildAuthorizeUrl,
  createOAuthState,
  fetchProfile,
  isProviderConfigured,
  verifyOAuthState,
  type OAuthProfile,
} from './oauth.js';
import { createSessionToken } from './session.js';
import { UsersService } from './services/users.js';
import { parseTransactionInput } from './services/transactions.js';
import { DEFAULT_SORT, MAX_CATEGORY_FILTER, SORT_KEYS } from './services/sql.js';
import { CURRENCIES, DEFAULT_CURRENCY, type Period } from './types.js';
import {
  ApiError,
  badRequest,
  notFound,
  optEnum,
  optNumber,
  reqAmountCents,
  reqCurrency,
  reqId,
  reqPeriod,
  reqText,
} from './validation.js';

const PROVIDERS = ['google', 'github'] as const;
type Provider = (typeof PROVIDERS)[number];

function asQuery(req: { query: unknown }): QueryString {
  return (req.query ?? {}) as QueryString;
}

/** Express hands params through as strings; narrow to a single value. */
function param(req: { params: Record<string, string | string[] | undefined> }, name: string): string {
  const value = req.params[name];
  return String(Array.isArray(value) ? value[0] : value ?? '');
}

function providerOr404(value: string): Provider {
  const hit = PROVIDERS.find((p) => p === value);
  if (!hit) {
    throw badRequest('provider_unsupported', `Unsupported provider "${value}". Use: ${PROVIDERS.join(', ')}`);
  }
  return hit;
}

function parseCategoryIds(raw: string | undefined): number[] {
  const text = String(raw ?? '').trim();
  if (text === '') return [];
  const ids = text
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) throw badRequest('category_ids_invalid', 'category_ids must be comma separated ids');
  if (ids.length > MAX_CATEGORY_FILTER) {
    throw badRequest('category_ids_invalid', `category_ids accepts at most ${MAX_CATEGORY_FILTER} values`);
  }
  return ids;
}

/** Current calendar month, which is the only period automatic alerts target. */
export function currentPeriod(now = new Date()): Period {
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

export function buildRouter(ctx: AppContext): Router {
  const router = Router();

  /* ------------------------------------------------------------------ health */

  router.get(
    '/health',
    wrap((_req, res) => {
      res.json({ ok: true, env: ctx.cfg.env, time: new Date().toISOString() });
    }),
  );

  /* -------------------------------------------------------------------- auth */

  router.get(
    '/auth/providers',
    wrap((_req, res) => {
      res.json({
        providers: PROVIDERS.map((name) => ({
          name,
          configured: isProviderConfigured(ctx.cfg, name),
          authorize_path: `/api/auth/${name}/login`,
        })),
        mock_auth_enabled: ctx.cfg.allowMockAuth,
      });
    }),
  );

  router.get(
    '/auth/me',
    wrap((req, res) => {
      const user = requireUser(req);
      res.json({ user: UsersService.toApi(user) });
    }),
  );

  router.get(
    '/auth/:provider/login',
    wrap((req, res) => {
      const provider = providerOr404(param(req, 'provider'));
      const config = ctx.cfg.providers[provider];
      if (!isProviderConfigured(ctx.cfg, provider)) {
        throw new ApiError(
          'oauth_not_configured',
          `${provider} SSO is not configured. Set ${provider.toUpperCase()}_CLIENT_ID and ${provider.toUpperCase()}_CLIENT_SECRET, or enable ALLOW_MOCK_AUTH=1 for local evaluation.`,
          501,
        );
      }
      const state = createOAuthState(ctx.cfg, provider);
      redirectAllowlisted(ctx.cfg, res, buildAuthorizeUrl(provider, config, state));
    }),
  );

  router.get(
    '/auth/:provider/callback',
    wrap(async (req, res) => {
      const provider = providerOr404(param(req, 'provider'));
      const query = asQuery(req);
      const expectedProvider = verifyOAuthState(ctx.cfg, query.state);
      if (expectedProvider !== provider) {
        throw new ApiError('oauth_state_mismatch', 'OAuth state check failed. Sign in again.', 400);
      }
      // A refusal arrives on this same URL: closing the consent sheet or hitting
      // Cancel yields ?error=access_denied and no code. Sending the browser a
      // JSON error document would be technically correct and practically useless,
      // so the reason travels back to the sign-in screen, which can show it.
      const refusal = String(query.error ?? '').trim();
      if (refusal !== '') {
        redirectAllowlisted(
          ctx.cfg,
          res,
          `${ctx.cfg.frontendOrigin}/?auth_error=${encodeURIComponent(refusal)}`,
        );
        return;
      }

      const code = String(query.code ?? '').trim();
      if (code === '') throw badRequest('code_missing', 'Authorization code missing from callback');

      const profile = await fetchProfile(provider, ctx.cfg, code, ctx.fetchImpl);
      signIn(ctx, res, profile);
      redirectAllowlisted(ctx.cfg, res, `${ctx.cfg.frontendOrigin}/#signed-in`);
    }),
  );

  /**
   * Local evaluation and automated-test entry point (ALLOW_MOCK_AUTH=1 only).
   * It exercises the exact same user-provisioning and session code path as a
   * real SSO callback, without any Google/GitHub network call.
   */
  router.post(
    '/auth/mock/login',
    wrap((req, res) => {
      if (!ctx.cfg.allowMockAuth) {
        throw new ApiError('mock_auth_disabled', 'Mock SSO is disabled', 404);
      }
      const body = (req.body ?? {}) as MockLoginBody;
      const provider = providerOr404(String(body.provider ?? 'google'));
      const mockUser = reqText(body.mock_user, 'mock_user', 64);
      const profile: OAuthProfile = {
        provider,
        provider_user_id: `mock-${mockUser}`,
        email: `${mockUser}@example.com`,
        display_name: `${mockUser.charAt(0).toUpperCase()}${mockUser.slice(1)} (SSO stub)`,
        avatar_url: null,
      };
      const result = signIn(ctx, res, profile);
      res.json({ user: UsersService.toApi(result.user), created: result.created });
    }),
  );

  router.post(
    '/auth/logout',
    wrap((req, res) => {
      // Clearing the cookie tells this browser to forget the session; revoking
      // by timestamp is what stops a copied or replayed token from working. A
      // call from an anonymous client is a harmless no-op.
      const user = (req as AuthedRequest).user;
      if (user) ctx.users.revokeSessions(user.id);
      clearSessionCookie(res, ctx.cfg);
      res.json({ ok: true });
    }),
  );

  /* --------------------------------------------------------------- categories */

  router.get(
    '/categories',
    wrap((req, res) => {
      const user = requireUser(req);
      res.json({ items: ctx.categories.list(user.id) });
    }),
  );

  router.post(
    '/categories',
    wrap((req, res) => {
      const user = requireUser(req);
      const body = (req.body ?? {}) as CategoryBody;
      const name = reqText(body.name, 'Name', 60);
      res.status(201).json({ item: ctx.categories.create(user.id, name) });
    }),
  );

  router.put(
    '/categories/:id',
    wrap((req, res) => {
      const user = requireUser(req);
      const body = (req.body ?? {}) as CategoryBody;
      const name = reqText(body.name, 'Name', 60);
      res.json({ item: ctx.categories.rename(user.id, reqId(param(req, 'id'), 'id'), name) });
    }),
  );

  router.delete(
    '/categories/:id',
    wrap((req, res) => {
      const user = requireUser(req);
      ctx.categories.delete(user.id, reqId(param(req, 'id'), 'id'));
      res.status(204).end();
    }),
  );

  /* ------------------------------------------------------------- transactions */

  router.get(
    '/transactions',
    wrap((req, res) => {
      const user = requireUser(req);
      const q = asQuery(req);
      const limit = Math.min(Math.max(Number(q.limit ?? 200) || 200, 1), 500);
      const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
      const result = ctx.transactions.list(user.id, {
        q: String(q.q ?? '').trim(),
        categoryIds: parseCategoryIds(q.category_ids),
        from: normalized(q.from),
        to: normalized(q.to),
        minCents: toCents(optNumber(q.min, 'min'), 'min'),
        maxCents: toCents(optNumber(q.max, 'max'), 'max'),
        sort: optEnum(q.sort, SORT_KEYS, 'sort') ?? DEFAULT_SORT,
        limit,
        offset,
      });
      res.json(result);
    }),
  );

  router.get(
    '/transactions/:id',
    wrap((req, res) => {
      const user = requireUser(req);
      const item = ctx.transactions.get(user.id, reqId(param(req, 'id'), 'id'));
      if (!item) throw notFound('Transaction not found');
      res.json({ item });
    }),
  );

  router.post(
    '/transactions',
    wrap((req, res) => {
      const user = requireUser(req);
      const body = (req.body ?? {}) as TransactionBody;
      const input = parseTransactionInput(body, { partial: false });
      const created = ctx.transactions.create(user.id, {
        title: input.title ?? '',
        amount_cents: input.amount_cents ?? 0,
        currency: input.currency ?? DEFAULT_CURRENCY,
        date: input.date ?? '',
        category_id: input.category_id ?? 0,
        notes: input.notes ?? '',
      });
      notifyBudget(ctx, user.id, periodOfDay(created.date));
      res.status(201).json({ item: created });
    }),
  );

  router.put(
    '/transactions/:id',
    wrap((req, res) => {
      const user = requireUser(req);
      const id = reqId(param(req, 'id'), 'id');
      const body = (req.body ?? {}) as TransactionBody;
      const before = ctx.transactions.get(user.id, id);
      if (!before) throw notFound('Transaction not found');
      const input = parseTransactionInput(body, { partial: true });
      const updated = ctx.transactions.update(user.id, id, input);
      notifyBudget(ctx, user.id, periodOfDay(updated.date));
      if (before.date !== updated.date) notifyBudget(ctx, user.id, periodOfDay(before.date));
      res.json({ item: updated });
    }),
  );

  router.delete(
    '/transactions/:id',
    wrap((req, res) => {
      const user = requireUser(req);
      const id = reqId(param(req, 'id'), 'id');
      const before = ctx.transactions.get(user.id, id);
      if (!before) throw notFound('Transaction not found');
      ctx.transactions.delete(user.id, id);
      notifyBudget(ctx, user.id, periodOfDay(before.date));
      res.status(204).end();
    }),
  );

  /* ------------------------------------------------------------------ budgets */

  router.get(
    '/budgets/summary',
    wrap((req, res) => {
      const user = requireUser(req);
      const q = asQuery(req);
      const period = q.year && q.month ? reqPeriod(q.year, q.month) : currentPeriod();
      res.json(ctx.budgets.summary(user.id, period));
    }),
  );

  router.get(
    '/budgets',
    wrap((req, res) => {
      const user = requireUser(req);
      const q = asQuery(req);
      const period = q.year && q.month ? reqPeriod(q.year, q.month) : currentPeriod();
      const row = ctx.budgets.get(user.id, period);
      res.json({
        period,
        budget: row ? { year: row.year, month: row.month, amount: row.amount_cents / 100, currency: row.currency } : null,
      });
    }),
  );

  router.put(
    '/budgets',
    wrap((req, res) => {
      const user = requireUser(req);
      const body = (req.body ?? {}) as BudgetBody;
      const q = asQuery(req);
      const year = body.year ?? q.year;
      const month = body.month ?? q.month;
      const period = year === undefined || month === undefined ? currentPeriod() : reqPeriod(String(year), String(month));
      const amountCents = reqAmountCents(body.amount, 'Budget amount');
      const currency = reqCurrency(body.currency, CURRENCIES);
      const budget = ctx.budgets.set(user.id, period, amountCents, currency);
      notifyBudget(ctx, user.id, period);
      res.json({ period, budget });
    }),
  );

  router.delete(
    '/budgets',
    wrap((req, res) => {
      const user = requireUser(req);
      const q = asQuery(req);
      const period = q.year && q.month ? reqPeriod(q.year, q.month) : currentPeriod();
      ctx.budgets.remove(user.id, period);
      res.status(204).end();
    }),
  );

  return router;
}

function signIn(ctx: AppContext, res: Response, profile: OAuthProfile) {
  const result = ctx.users.upsertFromProfile(profile);
  // The token is minted in the user's current session generation, so signing in
  // after a logout yields a working token while every pre-logout token stays dead.
  const token = createSessionToken(
    ctx.cfg.sessionSecret,
    result.user.id,
    ctx.cfg.sessionTtlSeconds,
    result.user.session_epoch,
  );
  setSessionCookie(res, ctx.cfg, token);
  return result;
}

/**
 * Alerts are computed for the period that changed, but delivered only to
 * subscribed sockets — and only when that period is the current calendar month,
 * which is the rule the spec sets for budget alerts.
 */
function notifyBudget(ctx: AppContext, userId: number, period: Period): void {
  const now = currentPeriod();
  if (period.year !== now.year || period.month !== now.month) return;
  ctx.hub.notifyBudgetChange(userId, period);
}

function periodOfDay(date: string): Period {
  const parts = String(date).split('-');
  return { year: Number(parts[0]), month: Number(parts[1]) };
}

function normalized(value: string | undefined): string | null {
  const text = String(value ?? '').trim();
  return text === '' ? null : text;
}

function toCents(value: number | undefined, field: string): number | null {
  if (value === undefined) return null;
  if (!(value >= 0)) throw badRequest('amount_invalid', `${field} must be greater than or equal to 0`);
  return Math.round(value * 100);
}
