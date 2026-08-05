/* Sketch Viewer — Service Worker.
   Дві окремі схованки:
     sketchcab-viewer-shell-*  — оболонка застосунку (HTML/CSS/JS/бібліотеки)
     sketch-data-*   — manifest.json та .glb конкретних проєктів
   Дані живуть довше за оболонку: оновлення в’ювера не стирає збережені моделі. */

const VERSION = 'v4.2.0-sketchcab';
const SHELL_CACHE = `sketchcab-viewer-shell-${VERSION}`;
const DATA_CACHE = 'sketchcab-viewer-data-v1';

const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './vendor/three/three.module.js',
  './vendor/three/addons/controls/OrbitControls.js',
  './vendor/three/addons/loaders/GLTFLoader.js',
  './vendor/three/addons/utils/BufferGeometryUtils.js',
  './vendor/html5-qrcode/html5-qrcode.min.js'
];

/* ---------- Встановлення ---------- */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // кожен файл окремо: відсутність однієї бібліотеки не зриває встановлення
    await Promise.all(SHELL_ASSETS.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (error) {
        console.warn('[Sketch SW] не закешовано:', url);
      }
    }));
    self.skipWaiting();
  })());
});

/* ---------- Активація ---------- */

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => {
      if (key.startsWith('sketchcab-viewer-shell-') && key !== SHELL_CACHE) return caches.delete(key);
      return null;
    }));
    await self.clients.claim();
  })());
});

/* ---------- Стратегії ---------- */

// Сторінка діагностики завжди береться з мережі — інакше вона показуватиме
// стан кешу замість реального стану сервера.
function isDiagnostics(url) {
  return url.pathname.endsWith('/check.html');
}

function isDataRequest(url) {
  return url.pathname.includes('/projects/') ||
    url.pathname.endsWith('.glb') ||
    url.pathname.endsWith('.gltf');
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreSearch: false });
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) cache.put(request, response.clone());
  return response;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isDiagnostics(url)) {
    event.respondWith(fetch(request).catch(() => caches.match(request)));
    return;
  }

  // Навігація: віддаємо оболонку, щоб застосунок відкривався офлайн
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch (error) {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  if (isDataRequest(url)) {
    // .glb — незмінні файли: спершу кеш; JSON — спершу мережа
    if (url.pathname.endsWith('.glb') || url.pathname.endsWith('.gltf')) {
      event.respondWith(cacheFirst(request, DATA_CACHE).catch(() => caches.match(request)));
    } else {
      event.respondWith(networkFirst(request, DATA_CACHE));
    }
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(request);
    if (cached) {
      // фонове оновлення
      fetch(request).then((response) => {
        if (response && response.ok) cache.put(request, response.clone());
      }).catch(() => {});
      return cached;
    }
    try {
      const response = await fetch(request);
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    } catch (error) {
      return Response.error();
    }
  })());
});

/* ---------- Повідомлення від застосунку ---------- */

self.addEventListener('message', (event) => {
  const data = event.data || {};

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (data.type === 'CACHE_URLS') {
    const port = event.ports && event.ports[0];
    event.waitUntil((async () => {
      const cache = await caches.open(DATA_CACHE);
      const urls = data.urls || [];
      let done = 0;
      let cached = 0;
      let failed = 0;

      for (const url of urls) {
        try {
          const response = await fetch(url, { cache: 'reload' });
          if (response && response.ok) {
            await cache.put(url, response.clone());
            cached += 1;
          } else {
            failed += 1;
          }
        } catch (error) {
          failed += 1;
        }
        done += 1;
        if (port) port.postMessage({ type: 'CACHE_PROGRESS', done, total: urls.length });
      }

      if (data.shell) {
        const shell = await caches.open(SHELL_CACHE);
        await Promise.all(SHELL_ASSETS.map((url) => shell.add(url).catch(() => null)));
      }

      if (port) port.postMessage({ type: 'CACHE_DONE', cached, failed, total: urls.length });
    })());
  }
});
