/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Pre-bundle lazily imported deps so the first chart doesn't trigger a dev-mode full reload.
  optimizeDeps: { include: ['vega-embed', 'vega', 'vega-lite', 'dockview-react'] },
  server: {
    port: 5173,
    // Keep the browser's Host header: the server checks Origin against it (CSRF guard).
    // ws: the live screens of the bots' computers use a WebSocket under /api.
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false, ws: true } },
  },
  test: { name: 'web', environment: 'jsdom' },
});
