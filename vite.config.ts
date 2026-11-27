import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

function normalizeBasePath(rawBase: string): string {
  const trimmed = rawBase.trim() || '/';
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

/**
 * Emits a self-contained offline Service Worker (`sw.js`) precaching all static HTML,
 * JS, CSS, Worker, and PWA assets under the configured `VITE_BASE_PATH` while keeping
 * large optional `.wasm` model runtimes lazy-cached on demand and never intercepting external APIs.
 */
function nibgridPwaPlugin(basePath: string): Plugin {
  return {
    name: 'nibgrid-pwa-sw',
    apply: 'build',
    generateBundle(_options, bundle) {
      const precachePaths = new Set<string>([
        basePath,
        `${basePath}index.html`,
        `${basePath}manifest.webmanifest`,
        `${basePath}icon.svg`,
      ]);

      for (const fileName of Object.keys(bundle)) {
        if (fileName.endsWith('.wasm') || fileName.endsWith('.map')) {
          continue;
        }
        precachePaths.add(`${basePath}${fileName}`);
      }

      const assetListJson = JSON.stringify(Array.from(precachePaths), null, 2);
      const cacheVersion = `nibgrid-offline-${Date.now().toString(36)}`;
      const indexUrl = `${basePath}index.html`;

      const swSource = `/* Nibgrid Offline Service Worker */
const CACHE_NAME = ${JSON.stringify(cacheVersion)};
const INDEX_URL = ${JSON.stringify(indexUrl)};
const PRECACHE_URLS = ${assetListJson};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match(req, { ignoreVary: true }).then((cached) =>
        cached ||
        caches.match(INDEX_URL, { ignoreVary: true }).then((indexCached) =>
          indexCached || fetch(req),
        ),
      ),
    );
    return;
  }

  event.respondWith(
    caches.match(req, { ignoreVary: true }).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((networkResponse) => {
        if (networkResponse.ok && url.pathname.startsWith(${JSON.stringify(basePath)})) {
          const clone = networkResponse.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return networkResponse;
      });
    }),
  );
});
`;

      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: swSource,
      });
    },
  };
}

const resolvedBase = normalizeBasePath(process.env.VITE_BASE_PATH ?? '/');

export default defineConfig({
  base: resolvedBase,
  plugins: [react(), tailwindcss(), nibgridPwaPlugin(resolvedBase)],
  worker: {
    format: 'es',
  },
});
