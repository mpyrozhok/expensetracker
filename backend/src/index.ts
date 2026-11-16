import http from 'node:http';
import { createApp } from './app.js';
import { WS_PATH } from './ws/hub.js';

const created = createApp();
const server = http.createServer(created.app);

created.ctx.hub.attach(server);

server.listen(created.ctx.cfg.port, created.ctx.cfg.host, () => {
  const { cfg } = created.ctx;
  const lines = [
    `Expense Tracker API listening on http://localhost:${cfg.port}`,
    `  env=${cfg.env} db=${cfg.databasePath}`,
    `  websocket=${WS_PATH}`,
    `  google_sso=${configured(cfg.providers.google.clientId)} github_sso=${configured(cfg.providers.github.clientId)}`,
    `  mock_sso=${cfg.allowMockAuth ? 'ENABLED (dev/test only)' : 'disabled'}`,
    cfg.staticDir ? `  serving SPA from ${cfg.staticDir}` : '  SPA served by Vite dev server on :5173',
  ];
  process.stdout.write(lines.join(String.fromCharCode(10)) + String.fromCharCode(10));
});

function configured(clientId: string): string {
  return clientId === '' ? 'not configured' : 'configured';
}

function shutdown(signal: string): void {
  process.stdout.write(`${signal} received, shutting down${String.fromCharCode(10)}`);
  server.close(() => {
    created.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
