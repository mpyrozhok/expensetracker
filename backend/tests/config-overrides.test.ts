/**
 * Environment overrides, specifically the present-but-empty case that dotfiles
 * and compose passthroughs produce (`GOOGLE_CLIENT_SECRET=`, `PORT=`). An empty
 * value used to win over the default, which yields a sign-in that redirects to
 * nothing and a server asked to listen on port 0.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const KEYS = [
  'PORT',
  'HOST',
  'FRONTEND_ORIGIN',
  'SESSION_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_REDIRECT_URI',
  'GITHUB_REDIRECT_URI',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_TOKEN_URL',
];

const GOOGLE_CALLBACK = 'http://localhost:8787/api/auth/google/callback';
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('empty overrides fall back to the default', () => {
  it('an empty redirect URI does not become a redirect to nothing', () => {
    process.env.GOOGLE_REDIRECT_URI = '';
    expect(loadConfig().providers.google.redirectUri).toBe(GOOGLE_CALLBACK);
  });

  it('an empty PORT does not become port 0, nor a portless callback', () => {
    process.env.PORT = '';
    const cfg = loadConfig();
    expect(cfg.port).toBe(8787);
    expect(cfg.providers.github.redirectUri).toContain('localhost:8787/');
  });

  it('an empty FRONTEND_ORIGIN does not blank the redirect allow-list', () => {
    process.env.FRONTEND_ORIGIN = '';
    expect(loadConfig().frontendOrigin).toBe('http://localhost:5173');
  });

  it('an empty endpoint URL keeps the real provider endpoint', () => {
    process.env.GITHUB_TOKEN_URL = '';
    expect(loadConfig().providers.github.tokenUrl).toBe('https://github.com/login/oauth/access_token');
  });

  it('an empty client id reads as not configured, which greys the button', () => {
    process.env.GITHUB_CLIENT_ID = '';
    expect(loadConfig().providers.github.clientId).toBe('');
  });
});

describe('overrides with values are used verbatim', () => {
  it('a redirect URI is taken as given', () => {
    process.env.GITHUB_REDIRECT_URI = 'http://localhost:8788/api/auth/github/callback';
    expect(loadConfig().providers.github.redirectUri).toBe(
      'http://localhost:8788/api/auth/github/callback',
    );
  });

  it('the default callback follows the app port, which is why publishing a container elsewhere needs the explicit override', () => {
    process.env.PORT = '9000';
    expect(loadConfig().providers.google.redirectUri).toBe(
      'http://localhost:9000/api/auth/google/callback',
    );
  });
});
