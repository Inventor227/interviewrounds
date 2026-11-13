import { iwsdkDev } from '@iwsdk/vite-plugin-dev';
import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

// The Rust server owns /api, /ws, /v1, /auth and /s. In dev we proxy them so the
// page stays same-origin, as it is in production.
const apiOrigin = process.env.IR_API_ORIGIN ?? 'http://127.0.0.1:8080';
const proxied = ['/api', '/v1', '/auth', '/s/', '/healthz'];

export default defineConfig({
  plugins: [
    preact(),
    iwsdkDev({
      emulator: { device: 'metaQuest3', environment: 'home_office' },
    }),
  ],
  server: {
    host: '0.0.0.0',
    port: 8081,
    open: false,
    proxy: {
      ...Object.fromEntries(proxied.map((p) => [p, { target: apiOrigin, changeOrigin: true }])),
      '/ws': { target: apiOrigin, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
    sourcemap: true,
  },
  esbuild: { target: 'esnext' },
  // Keep a single copy of three and uikit (IWSDK relies on instanceof checks).
  resolve: {
    dedupe: ['three', '@pmndrs/uikit', 'preact'],
  },
  optimizeDeps: {
    exclude: ['@babylonjs/havok'],
    esbuildOptions: { target: 'esnext' },
  },
});
