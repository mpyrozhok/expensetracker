import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export type ProviderName = 'google' | 'github';

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Authorization endpoint override (used by the local stub provider in tests). */
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string[];
}

export interface AppConfig {
  env: string;
  port: number;
  host: string;
  databasePath: string;
  sessionSecret: string;
  sessionTtlSeconds: number;
  frontendOrigin: string;
  cookieSecure: boolean;
  /** Enables the local stub SSO provider (never use in production). */
  allowMockAuth: boolean;
  providers: Record<ProviderName, OAuthProviderConfig>;
  /** When set (production single-process mode), Express serves this directory. */
  staticDir?: string;
}

const env = process.env;

function bool(v: string | undefined, def = false): boolean {
  if (v === undefined) return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function providerDefaults(p: ProviderName) {
  return p === 'google'
    ? {
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
        scopes: ['openid', 'profile', 'email'],
      }
    : {
        authorizeUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        userInfoUrl: 'https://api.github.com/user',
        scopes: ['read:user', 'user:email'],
      };
}

/**
 * An override that is present but empty means "not set". Dotfiles and compose
 * passthroughs routinely export `GOOGLE_CLIENT_SECRET=` or `PORT=`, and for
 * these keys an empty value is a broken launch rather than a default: an empty
 * redirect URI sends the provider a `redirect_uri=` of nothing, and an empty
 * PORT became port 0.
 */
function override(name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

function providerConfig(p: ProviderName): OAuthProviderConfig {
  const upper = p.toUpperCase();
  const d = providerDefaults(p);
  const port = override('PORT') ?? '8787';
  return {
    clientId: override(`${upper}_CLIENT_ID`) ?? '',
    clientSecret: override(`${upper}_CLIENT_SECRET`) ?? '',
    redirectUri:
      override(`${upper}_REDIRECT_URI`) ??
      `http://localhost:${port}/api/auth/${p}/callback`,
    authorizeUrl: override(`${upper}_AUTHORIZE_URL`) ?? d.authorizeUrl,
    tokenUrl: override(`${upper}_TOKEN_URL`) ?? d.tokenUrl,
    userInfoUrl: override(`${upper}_USERINFO_URL`) ?? d.userInfoUrl,
    scopes: (env[`${upper}_SCOPES`] ?? '').split(' ').filter(Boolean).length
      ? (env[`${upper}_SCOPES`] as string).split(' ').filter(Boolean)
      : d.scopes,
  };
}

function defaultDatabasePath(): string {
  if (env.DATABASE_PATH) return env.DATABASE_PATH;
  if ((env.NODE_ENV ?? 'development') === 'test') {
    return path.join(os.tmpdir(), `expense-tracker-test-${process.pid}-${Date.now()}.db`);
  }
  return path.join(process.cwd(), 'data', 'app.db');
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const databasePath = defaultDatabasePath();
  fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });

  const cfg: AppConfig = {
    env: nodeEnv,
    port: Number(override('PORT') ?? 8787),
    host: override('HOST') ?? '0.0.0.0',
    databasePath,
    sessionSecret:
      override('SESSION_SECRET') ??
      (nodeEnv === 'production'
        ? ''
        : 'dev-insecure-session-secret-change-me-0123456789abcdef'),
    sessionTtlSeconds: Number(override('SESSION_TTL_SECONDS') ?? 60 * 60 * 24 * 30),
    frontendOrigin: override('FRONTEND_ORIGIN') ?? 'http://localhost:5173',
    cookieSecure: bool(env.COOKIE_SECURE, nodeEnv === 'production'),
    allowMockAuth: bool(env.ALLOW_MOCK_AUTH, nodeEnv !== 'production'),
    providers: {
      google: providerConfig('google'),
      github: providerConfig('github'),
    },
    staticDir: env.STATIC_DIR && fs.existsSync(env.STATIC_DIR) ? env.STATIC_DIR : undefined,
    ...overrides,
  };

  if (!cfg.sessionSecret) {
    throw new Error(
      'SESSION_SECRET is required in production. Generate one with: openssl rand -hex 32',
    );
  }
  return cfg;
}
