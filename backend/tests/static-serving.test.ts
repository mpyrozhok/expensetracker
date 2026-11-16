import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp, type CreatedApp } from '../src/app.js';

/**
 * The containerized / production mode is single-origin: Express serves the built
 * SPA as well as the API. These checks pin that contract, including the part that
 * is easy to break by re-ordering middleware - the SPA fallback must not swallow
 * API errors, and the API 404 must stay JSON.
 */
interface StaticApp extends CreatedApp {
  dir: string;
}

function appWithStaticBundle(): StaticApp {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expense-static-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><title>SPA</title></html>');
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'index.js'), 'console.log("bundle");');
  const created = createApp({
    config: { databasePath: ':memory:', staticDir: dir, allowMockAuth: true },
  });
  return Object.assign(created, { dir });
}

describe('serving the built SPA from the API origin', () => {
  it('answers the root document with the bundle entry point', async () => {
    const app = appWithStaticBundle();
    const res = await request(app.app).get('/').expect(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('<title>SPA</title>');
    app.close();
  });

  it('serves hashed asset files directly from disk', async () => {
    const app = appWithStaticBundle();
    const res = await request(app.app).get('/assets/index.js').expect(200);
    expect(res.text).toContain('console.log');
    app.close();
  });

  it('falls back to the document for client-side routes', async () => {
    const app = appWithStaticBundle();
    const res = await request(app.app).get('/some/deep/route').expect(200);
    expect(res.text).toContain('<title>SPA</title>');
    app.close();
  });

  it('keeps API errors as JSON instead of handing them to the SPA', async () => {
    const app = appWithStaticBundle();
    const missing = await request(app.app).get('/api/does-not-exist').expect(404);
    expect(missing.headers['content-type']).toContain('application/json');
    expect(missing.body.error.code).toBe('not_found');

    const unauthenticated = await request(app.app).get('/api/transactions').expect(401);
    expect(unauthenticated.body.error.code).toBe('unauthorized');
    app.close();
  });

  it('does not let the SPA read like an API answer on /api itself', async () => {
    const app = appWithStaticBundle();
    const res = await request(app.app).get('/api').expect(404);
    expect(res.headers['content-type']).toContain('application/json');
    app.close();
  });

  it('reports a plain 404 when no bundle is configured (development mode)', async () => {
    const app = createApp({ config: { databasePath: ':memory:', staticDir: undefined } });
    const res = await request(app.app).get('/').expect(404);
    expect(res.body.error.code).toBe('not_found');
    // Health and auth still work without a bundle, which is how `npm run dev` runs.
    await request(app.app).get('/api/health').expect(200);
    app.close();
  });
});
