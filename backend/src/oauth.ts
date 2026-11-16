import crypto from 'node:crypto';
import type { AppConfig, ProviderName, OAuthProviderConfig } from './config.js';

/** Normalized identity returned by every SSO provider. */
export interface OAuthProfile {
  provider: ProviderName;
  provider_user_id: string;
  email: string | null;
  display_name: string;
  avatar_url: string | null;
}

/** Signature-compatible with global fetch; injectable so tests never hit the network. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<any>;
}>;

export class OAuthError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 502, code = 'oauth_error') {
    super(message);
    this.name = 'OAuthError';
    this.status = status;
    this.code = code;
  }
}

export function createOAuthState(cfg: AppConfig, provider: string): string {
  const nonce = crypto.randomBytes(16).toString('hex');
  const body = Buffer.from(JSON.stringify({ provider, nonce })).toString('base64url');
  return `${body}.${hmac(cfg.sessionSecret, body)}`;
}

export function verifyOAuthState(cfg: AppConfig, state: string | undefined): string | null {
  if (!state) return null;
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  const expected = hmac(cfg.sessionSecret, body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let parsed: StatePayload;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload;
  } catch {
    return null;
  }
  return str(parsed.provider) ?? null;
}

interface StatePayload {
  provider?: string;
  nonce?: string;
}

function hmac(secret: string, data: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

/** Coerce an untrusted JSON field to a non-empty string, else undefined. */
function str(value?: string | number | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s === '' ? undefined : s;
}

/** Coerce an untrusted JSON id field (number or string) to a string, else undefined. */
function id(value?: string | number | null): string | undefined {
  return str(value);
}

export function buildAuthorizeUrl(
  provider: ProviderName,
  pc: OAuthProviderConfig,
  state: string,
  extraParams: Record<string, string> = {},
): string {
  const url = new URL(pc.authorizeUrl);
  url.searchParams.set('client_id', pc.clientId);
  url.searchParams.set('redirect_uri', pc.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', pc.scopes.join(' '));
  url.searchParams.set('state', state);
  if (provider === 'google') {
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'select_account');
  }
  for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v);
  return url.toString();
}

interface AccessTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

type ProviderResponse = Awaited<ReturnType<FetchLike>>;

async function formPost(fetchImpl: FetchLike, url: string, form: Record<string, string>, accept: string): Promise<ProviderResponse> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept,
      'user-agent': 'expense-tracker/1.0',
    },
    body: new URLSearchParams(form).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new OAuthError(`${url} responded ${res.status}: ${text.slice(0, 200)}`, 502);
  }
  return res;
}

async function getJson(fetchImpl: FetchLike, url: string, headers: Record<string, string>) {
  const res = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json', ...headers } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new OAuthError(`${url} responded ${res.status}: ${text.slice(0, 200)}`, 502);
  }
  return res.json();
}

interface GoogleUserInfo {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

interface GitHubUser {
  id?: number | string;
  login?: string;
  name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
}

interface GitHubEmail {
  email?: string;
  primary?: boolean;
  verified?: boolean;
}

async function exchangeCodeForToken(
  provider: ProviderName,
  pc: OAuthProviderConfig,
  code: string,
  fetchImpl: FetchLike,
): Promise<string> {
  const res = await formPost(
    fetchImpl,
    pc.tokenUrl,
    {
      grant_type: 'authorization_code',
      client_id: pc.clientId,
      client_secret: pc.clientSecret,
      code,
      redirect_uri: pc.redirectUri,
    },
    provider === 'google' ? 'application/json' : 'application/json',
  );
  const data = (await res.json().catch(() => ({}))) as AccessTokenResponse;
  const accessToken = str(data.access_token);
  if (!accessToken) {
    const reason = str(data.error_description) ?? str(data.error);
    throw new OAuthError(
      `${provider} did not return an access_token${reason ? `: ${reason}` : ''}`,
      502,
    );
  }
  return accessToken;
}

/**
 * Completes the OAuth2 authorization-code flow for `provider` and returns the
 * normalized profile. All network access goes through `fetchImpl`, which tests
 * stub out — no real Google/GitHub calls are ever made from the test suite.
 */
export async function fetchProfile(
  provider: ProviderName,
  cfg: AppConfig,
  code: string,
  fetchImpl: FetchLike,
): Promise<OAuthProfile> {
  const pc = cfg.providers[provider];
  if (!pc.clientId || !pc.clientSecret) {
    throw new OAuthError(
      `${provider} OAuth is not configured (set ${provider.toUpperCase()}_CLIENT_ID and ${provider.toUpperCase()}_CLIENT_SECRET)`,
      500,
      'oauth_not_configured',
    );
  }
  const accessToken = await exchangeCodeForToken(provider, pc, code, fetchImpl);

  if (provider === 'google') {
    const me = (await getJson(fetchImpl, pc.userInfoUrl, {
      authorization: `Bearer ${accessToken}`,
    })) as GoogleUserInfo;
    const sub = id(me.sub);
    if (!sub) throw new OAuthError('Google userinfo response has no sub claim', 502);
    const email = str(me.email);
    return {
      provider: 'google',
      provider_user_id: sub,
      email: email ? email.toLowerCase() : null,
      display_name: str(me.name) ?? email?.split('@')[0] ?? 'Google user',
      avatar_url: str(me.picture) ?? null,
    };
  }

  const me = (await getJson(fetchImpl, pc.userInfoUrl, {
    authorization: `Bearer ${accessToken}`,
    'user-agent': 'expense-tracker/1.0',
  })) as GitHubUser;
  const githubId = id(me.id);
  if (!githubId) throw new OAuthError('GitHub user response has no id', 502);
  const primaryEmail = str(me.email);
  let email = primaryEmail ? primaryEmail.toLowerCase() : null;
  if (!email) {
    // GitHub hides the primary address unless the user opted in; try the emails endpoint.
    try {
      const emails = (await getJson(fetchImpl, `${pc.userInfoUrl.replace('/user', '')}/user/emails`, {
        authorization: `Bearer ${accessToken}`,
        'user-agent': 'expense-tracker/1.0',
      })) as GitHubEmail[];
      const picked = Array.isArray(emails)
        ? emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified) ?? emails[0]
        : undefined;
      const fallback = str(picked?.email);
      if (fallback) email = fallback.toLowerCase();
    } catch {
      email = null;
    }
  }
  return {
    provider: 'github',
    provider_user_id: githubId,
    email,
    display_name: str(me.name) ?? str(me.login) ?? 'GitHub user',
    avatar_url: str(me.avatar_url) ?? null,
  };
}

export function isProviderConfigured(cfg: AppConfig, provider: ProviderName): boolean {
  const pc = cfg.providers[provider];
  return Boolean(pc.clientId && pc.clientSecret);
}
