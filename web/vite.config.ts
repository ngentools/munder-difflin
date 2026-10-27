import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Web/PWA build of the SAME renderer. `electron` resolves to web/electron-shim.ts,
// so the preload bridge (window.cth) works in the browser with no code changes.
const root = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
const bridge = `http://127.0.0.1:${process.env.WEB_PORT ?? 3900}`;

export default defineConfig({
  root: __dirname,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // preload reads process.platform/arch for display; a browser has no `process`.
    'process.platform': JSON.stringify(process.platform),
    'process.arch': JSON.stringify(process.arch)
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Munder Difflin',
        short_name: 'Munder Difflin',
        description: 'Multi-agent office harness',
        start_url: '/',
        display: 'standalone',
        background_color: '#FFF8E7',
        theme_color: '#6E1423',
        icons: [{ src: '/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }]
      },
      workbox: {
        // Monaco and the renderer bundle are large; precache them so the shell works offline.
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
        // The API and event stream are never cached or rewritten to index.html.
        navigateFallbackDenylist: [/^\/api\//, /^\/events/]
      }
    })
  ],
  resolve: {
    alias: [
      { find: /^electron$/, replacement: resolve(__dirname, 'electron-shim.ts') },
      { find: '@brand', replacement: resolve(root, 'docs') },
      { find: '@shared', replacement: resolve(root, 'src/shared') },
      { find: '@', replacement: resolve(root, 'src/renderer/src') }
    ]
  },
  server: {
    port: 5174,
    proxy: {
      '/api': { target: bridge, changeOrigin: false },
      '/events': { target: bridge, changeOrigin: false }
    }
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true
  }
});
