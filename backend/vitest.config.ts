import { defineConfig } from 'vitest/config';

// The suite must never touch Google or GitHub: every SSO call is served by the
// stub fetch injected through testEnv(), and no provider credentials are set.
process.env.NODE_ENV = 'test';
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.GITHUB_CLIENT_ID;
delete process.env.GITHUB_CLIENT_SECRET;
process.env.ALLOW_MOCK_AUTH = '1';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef-0123456789abcdef';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    // Apps share nothing but each test opens its own in-memory database, so
    // files can run sequentially to keep the WebSocket timings deterministic.
    fileParallelism: false,
  },
});
