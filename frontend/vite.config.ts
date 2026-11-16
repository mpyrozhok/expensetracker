/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = process.env.VITE_BACKEND_ORIGIN ?? 'http://localhost:8787';

// The SPA talks to the API through this proxy, so the session cookie is
// first-party in development and the WebSocket upgrade reaches the backend too.
// Vite upgrades the http(s) target itself when `ws: true`, so the scheme always
// follows the page protocol (wss over https) instead of a hard-coded ws://.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: backend, changeOrigin: true },
      '/ws': { target: backend, ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    css: false,
  },
});
