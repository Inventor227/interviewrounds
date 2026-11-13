import { iwsdkDev } from '@iwsdk/vite-plugin-dev';
import preact from '@preact/preset-vite';
import { defineConfig, type Plugin } from 'vite';

// The Rust server owns /api, /ws, /v1, /auth and /s. In dev we proxy them so the
// page stays same-origin, as it is in production.
const apiOrigin = process.env.IR_API_ORIGIN ?? 'http://127.0.0.1:8080';
const proxied = ['/api', '/v1', '/auth', '/s/', '/healthz'];

// The IWSDK dev plugin excludes preact from dependency pre-bundling, while the Preact
// preset includes it, and esbuild refuses both. Keep preact pre-bundled so the app and
// preact-iso share one copy.
function sharePreact(): Plugin {
  return {
    name: 'ir:share-preact',
    enforce: 'post',
    config(config) {
      const ex = config.optimizeDeps?.exclude;
      if (ex) config.optimizeDeps!.exclude = ex.filter((d) => !/^preact(\/|$)/.test(d));
    },
  };
}

export default defineConfig({
  plugins: [
    preact(),
    // World and emulator settings (Quest 3, home_office room) live in iwsdk.config.json,
    // which this IWSDK version requires as the single source for them.
    iwsdkDev(),
    sharePreact(),
  ],
  server: {
    host: '0.0.0.0',
    port: 8081,
    open: false,
    // Headless emulator runs (the IWSDK CLI sets IWSDK_DEV_AI_MODE=agent) share a host whose
    // inotify instances can run out; polling avoids that and HMR speed does not matter there.
    watch: process.env.IWSDK_DEV_AI_MODE === 'agent' ? { usePolling: true, interval: 1000 } : undefined,
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
