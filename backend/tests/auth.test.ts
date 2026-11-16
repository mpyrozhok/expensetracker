import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { stubProviders, testEnv } from './helpers.js';

/**
 * A stub of the Google and GitHub token/userinfo endpoints. No test performs a
 * real network call: the app is constructed with this fetch implementation.
 */
const STUB_IDENTITY = {
  google: { sub: 'google-111', email: 'ADA@Example.com', name: 'Ada Lovelace', picture: 'https://x/ada.png' },
  github: { id: 4242, login: 'ada', name: null, email: null, avatar_url: 'https://x/ada-gh.png' },
};

export function stubFetch(calls: string[] = []) {
  return (async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const json = (body: unknown, status = 200) =>
      ({
        ok: status < 400,
        status,
        text: async () => JSON.stringify(body),
        json: async () => body,
      }) as never;

    if (url.includes('/token') || url.includes('access_token')) {
      return json({ access_token: 'stub-access-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (url.includes('/userinfo')) {
      const auth = String(init?.headers?.authorization ?? '');
      if (!auth.includes('stub-access-token')) return json({ error: 'invalid_grant' }, 401);
      return json(STUB_IDENTITY.google);
    }
    if (url.endsWith('/user/emails')) {
      // GitHub hides the address on /user; the emails endpoint supplies it.
      return json([{ email: 'ada@example.com', primary: true, verified: true }]);
    }
    if (url.endsWith('/user')) {
      return json(STUB_IDENTITY.github);
    }
    return json({ error: 'not_found' }, 404);
  }) as never;
}

describe('SSO sign-in (stubbed providers)', () => {
  it('completes the Google OIDC code exchange and creates the local user', async () => {
    const calls: string[] = [];
    const app = testEnv({ fetchImpl: stubFetch(calls) });

    const login = await app.api.get('/api/auth/google/login').expect(302);
    const authorizeUrl = new URL(headerOf(login, 'location'));
    expect(authorizeUrl.origin).toBe('https://accounts.google.com');
    expect(authorizeUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizeUrl.searchParams.get('scope')).toBe('openid profile email');
    expect(authorizeUrl.searchParams.get('client_id')).toBe('stub-google.apps.example.com');
    const state = String(authorizeUrl.searchParams.get('state'));

    const callback = await app.api
      .get(`/api/auth/google/callback?code=stub-code&state=${encodeURIComponent(state)}`)
      .expect(302);

    expect(callback.get('location')).toContain('#signed-in');
    const sessionCookie = cookieHeaderOf(callback);
    expect(sessionCookie).toContain('et_session=');
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('SameSite=Lax');

    const me = await app.api.get('/api/auth/me').expect(200);
    expect(me.body.user).toMatchObject({
      provider: 'google',
      email: 'ada@example.com',
      display_name: 'Ada Lovelace',
      avatar_url: 'https://x/ada.png',
    });

    // Identity is persisted as provider + provider_user_id, not as email.
    const row = app.ctx.db
      .prepare('SELECT provider, provider_user_id FROM users WHERE id = ?')
      .get(me.body.user.id) as { provider: string; provider_user_id: string };
    expect(row).toEqual({ provider: 'google', provider_user_id: 'google-111' });

    expect(calls.some((c) => c.includes('/token'))).toBe(true);
    expect(calls.some((c) => c.includes('/userinfo'))).toBe(true);
    // The authorize URL was built, never requested; only the stub was called.
    expect(calls.some((c) => c.includes('accounts.google.com'))).toBe(false);
    app.close();
  });

  it('treats the same human on Google and GitHub as two accounts (no linking)', async () => {
    const calls: string[] = [];
    const app = testEnv({ fetchImpl: stubFetch(calls) });

    const googleLogin = await app.api.get('/api/auth/google/login').expect(302);
    const googleState = String(new URL(headerOf(googleLogin, 'location')).searchParams.get('state'));
    await app.api
      .get(`/api/auth/google/callback?code=stub-code&state=${encodeURIComponent(googleState)}`)
      .expect(302);
    const viaGoogle = await app.api.get('/api/auth/me').expect(200);

    // The same person, this time through GitHub, in the same browser session.
    const githubLogin = await app.api.get('/api/auth/github/login').expect(302);
    const githubState = String(new URL(headerOf(githubLogin, 'location')).searchParams.get('state'));
    await app.api
      .get(`/api/auth/github/callback?code=stub-code&state=${encodeURIComponent(githubState)}`)
      .expect(302);
    const viaGithub = await app.api.get('/api/auth/me').expect(200);

    expect(viaGoogle.body.user.provider).toBe('google');
    expect(viaGithub.body.user.provider).toBe('github');
    expect(viaGithub.body.user).toMatchObject({ email: 'ada@example.com', display_name: 'ada' });
    expect(calls.some((c) => c.includes('api.github.com/user/emails'))).toBe(true);

    // GitHub hides the address on /user, so identity keys on provider +
    // provider_user_id: two rows even though both accounts carry one email.
    const rows = app.ctx.db
      .prepare('SELECT provider, provider_user_id, email FROM users ORDER BY id')
      .all() as { provider: string; provider_user_id: string; email: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.provider)).toEqual(['google', 'github']);
    expect(rows.map((r) => r.provider_user_id)).toEqual(['google-111', '4242']);
    expect(new Set(rows.map((r) => r.email))).toEqual(new Set(['ada@example.com']));
    expect(viaGithub.body.user.id).not.toBe(viaGoogle.body.user.id);
    app.close();
  });

  it('reuses the existing user on a second sign-in instead of duplicating it', async () => {
    const app = testEnv();
    const first = await app.api.login('ada');
    const second = await app.api.login('ada');
    expect(first.body.created).toBe(true);
    expect(second.body.user.id).toBe(first.body.user.id);
    expect(second.body.created).toBe(false);
    const users = app.ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    expect(users.n).toBe(1);
    app.close();
  });

  it('rejects a callback whose state was not issued by us', async () => {
    const app = testEnv({ fetchImpl: stubFetch() });
    const res = await app.api.get('/api/auth/google/callback?code=stub-code&state=Zm9v.YmFy');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('oauth_state_mismatch');
    app.close();
  });

  it('sends a refused sign-in back to the screen with the provider reason', async () => {
    const app = testEnv({ fetchImpl: stubFetch() });
    const login = await app.api.get('/api/auth/google/login').expect(302);
    const state = String(new URL(headerOf(login, 'location')).searchParams.get('state'));

    // Pressing Cancel on the consent sheet is the commonest way a real sign-in
    // fails: the provider sends an error and no code, to this callback URL.
    const refused = await app.api
      .get(`/api/auth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`)
      .expect(302);
    const back = new URL(headerOf(refused, 'location'));
    expect(back.pathname).toBe('/');
    expect(back.searchParams.get('auth_error')).toBe('access_denied');
    // A refusal is not a session.
    await app.api.get('/api/auth/me').expect(401);
    app.close();
  });

  it('validates state even when the provider reports its own error', async () => {
    // Otherwise a third party could push arbitrary error text into the app's own
    // URL, which the sign-in screen then renders.
    const app = testEnv({ fetchImpl: stubFetch() });
    const res = await app.api.get('/api/auth/google/callback?error=access_denied&state=Zm9v.YmFy');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('oauth_state_mismatch');
    app.close();
  });

  it('supports logout and refuses authenticated routes afterwards', async () => {
    const app = testEnv();
    await app.api.login('ada');
    await app.api.get('/api/auth/me').expect(200);
    await app.api.post('/api/auth/logout').expect(200);
    await app.api.get('/api/auth/me').expect(401);
    app.close();
  });

  it('revokes issued tokens on logout, not merely the browser cookie', async () => {
    const app = testEnv();
    await app.api.login('ada');
    const stolen = app.api.token();
    const replay = () =>
      request(app.app).get('/api/auth/me').set('Authorization', `Bearer ${stolen}`);

    // While the session lives the token authenticates on its own, with no cookie.
    await replay().expect(200);

    await app.api.post('/api/auth/logout').expect(200);

    // The token is still cryptographically valid and unexpired; what changed is
    // that the session generation it belongs to has been retired server-side.
    await replay().expect(401);

    // Signing in again mints a token in the new generation, so the user is not
    // locked out — but the retired token stays dead forever.
    await app.api.login('ada');
    await app.api.get('/api/auth/me').expect(200);
    await replay().expect(401);
    app.close();
  });

  it('refuses to mint a session for a provider identity that was never signed in', async () => {
    const app = testEnv();
    const unknown = await app.api.get('/api/auth/me').set('Authorization', 'Bearer garbage');
    expect(unknown.status).toBe(401);
    app.close();
  });

  it('reports which providers are configured and refuses unconfigured logins', async () => {
    const app = testEnv({
      config: { providers: { ...stubProviders(), google: { ...stubProviders().google, clientSecret: '' } } },
    });
    const providers = await app.api.get('/api/auth/providers').expect(200);
    expect(providers.body.mock_auth_enabled).toBe(true);
    expect(providers.body.providers).toEqual([
      expect.objectContaining({ name: 'google', configured: false }),
      expect.objectContaining({ name: 'github', configured: true }),
    ]);
    const res = await app.api.get('/api/auth/google/login');
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('oauth_not_configured');
    await app.api.get('/api/auth/facebook/login').expect(400);
    app.close();
  });

  it('requires the CSRF header on state-changing calls', async () => {
    const app = testEnv();
    await app.api.login('ada');
    // Same cookie, but without the custom header a cross-site form cannot set.
    const res = await request(app.app).post('/api/categories').set('Cookie', cookieOf(app)).send({ name: 'Nope' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('csrf_header_missing');
    await app.api.post('/api/categories').send({ name: 'Groceries' }).expect(201);
    app.close();
  });

  it('uses a throwaway in-memory database per test app', () => {
    const app = testEnv();
    expect(app.ctx.cfg.databasePath).toBe(':memory:');
    app.close();
  });
});

/** Response headers are optional by type; tests want a hard failure, not undefined math. */
function headerOf(res: { headers: Record<string, string | string[] | undefined> }, name: string): string {
  const value = res.headers[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

/** Set-Cookie attributes contain commas, so read the cookie array rather than splitting. */
function cookieHeaderOf(res: { headers: Record<string, string | string[] | undefined> }): string {
  const value = res.headers['set-cookie'];
  if (Array.isArray(value)) return value.join('; ');
  return value ?? '';
}

function cookieOf(app: ReturnType<typeof testEnv>): string {
  const token = app.api.token();
  return `et_session=${token}`;
}
