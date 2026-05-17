import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
);

// Build-time SHA is "unknown" outside CI; Fly.io exposes FLY_IMAGE_REF /
// SOURCE_VERSION on deploys, but locally we just want *something* so the
// login chip can show "v1.0.0 · dev".
const buildSha =
  process.env.SOURCE_VERSION ||
  process.env.FLY_IMAGE_REF?.split(':').pop() ||
  process.env.GITHUB_SHA ||
  'dev';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      // We hand-author the manifest in client/public/manifest.webmanifest so
      // the meta tag in index.html resolves at first paint, before the SW
      // ever installs. Tell the plugin not to also emit its own.
      manifest: false,
      includeAssets: ['favicon.svg', 'favicon-monochrome.svg', 'og-image.svg'],
      workbox: {
        // App shell — HTML/JS/CSS/icons. Stale-while-revalidate would let
        // a user see the previous deploy's UI for one tick; for an
        // operational tool we'd rather block-then-refresh.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/socket\.io/],
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        runtimeCaching: [
          // CRITICAL: NEVER cache API responses. This is a safety-of-life
          // tool — a cached "ALL CLEAR" served while the operator is
          // offline could send people back outside during a storm.
          {
            urlPattern: ({ url }) =>
              url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/'),
            handler: 'NetworkOnly',
          },
          // Leaflet tiles — cache aggressively, they're static and huge.
          {
            urlPattern: /^https:\/\/.*\.tile\.openstreetmap\.org\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'osm-tiles',
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          // Google Fonts — long-lived CSS + woff2 files.
          {
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\//,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'google-fonts',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
      // Devtools-friendly: by default the SW is only built in `vite build`;
      // enable it in dev so we can smoke-test install + offline locally.
      devOptions: {
        enabled: false,
        type: 'module',
      },
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_BUILD__: JSON.stringify(buildSha.slice(0, 7)),
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      // socket.io connects to /socket.io/* by default. Proxy with ws upgrades.
      '/socket.io': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
