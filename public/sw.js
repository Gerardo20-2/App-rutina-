/**
 * Service Worker de RoutineTracker.
 *
 * Se carga desde el `sw.js` de la raíz mediante `importScripts`, de modo que
 * el worker queda registrado con alcance `/` (o `/<repo>/` en GitHub Pages) y
 * puede controlar toda la aplicación, mientras la implementación vive donde
 * marca la arquitectura: `public/sw.js`. Las URLs relativas de este archivo se
 * resuelven contra la raíz de la aplicación, no contra `public/`.
 *
 * Estrategias:
 *   · Navegaciones  → network-first con tiempo límite y caída al shell cacheado.
 *                     Así una versión nueva se ve al primer intento con red, y
 *                     sin red la app abre igual.
 *   · Estáticos     → stale-while-revalidate. Se sirve del caché al instante y
 *                     se refresca en segundo plano para el siguiente arranque.
 *   · Resto / cross-origin → passthrough, sin tocar el caché.
 */

/* eslint-env serviceworker */

const CACHE_NAME = 'routine-tracker-v2';
const NAVIGATION_TIMEOUT_MS = 3000;

/** Shell mínimo para arrancar sin red. */
const PRECACHE_URLS = [
  './',
  './index.html',
  './public/manifest.webmanifest',
  './public/icons/icon-192.png',
  './public/icons/icon-512.png',
  './src/main.js',
  './src/core/constants.js',
  './src/core/events.js',
  './src/core/store.js',
  './src/core/dateUtils.js',
  './src/domain/taskValidator.js',
  './src/domain/streakCalculator.js',
  './src/domain/dayResetService.js',
  './src/domain/routineService.js',
  './src/domain/selectors.js',
  './src/storage/storageAdapter.js',
  './src/storage/indexedDbService.js',
  './src/storage/localStorageService.js',
  './src/storage/repository.js',
  './src/platform/gestures.js',
  './src/platform/haptics.js',
  './src/platform/wakeLock.js',
  './src/ui/renderer.js',
  './src/ui/dom.js',
  './src/ui/components/header.js',
  './src/ui/components/taskItem.js',
  './src/ui/components/taskList.js',
  './src/ui/components/heatmap.js',
  './src/ui/components/taskEditor.js',
  './src/ui/components/settingsPanel.js',
  './src/ui/components/toast.js',
  './src/ui/styles/base.css',
  './src/ui/styles/layout.css',
  './src/ui/styles/components.css',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // `addAll` es atómico: un 404 abortaría la instalación entera, así que
    // cada recurso se añade por separado y un fallo aislado no rompe el SW.
    await Promise.all(PRECACHE_URLS.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (error) {
        console.warn('[SW] no se pudo precachear', url, error);
      }
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)));
    // Acelera la primera carga tras la instalación en navegadores compatibles.
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.enable();
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

/**
 * Network-first acotado en el tiempo: si la red tarda más que el umbral, se
 * sirve el shell cacheado en lugar de dejar la pantalla en blanco.
 * @param {FetchEvent} event
 */
async function handleNavigation(event) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const preloaded = await event.preloadResponse;
    if (preloaded) {
      void cache.put('./index.html', preloaded.clone());
      return preloaded;
    }
    const response = await withTimeout(fetch(event.request), NAVIGATION_TIMEOUT_MS);
    if (response && response.ok) {
      void cache.put('./index.html', response.clone());
    }
    return response;
  } catch {
    return (await cache.match('./index.html'))
      ?? (await cache.match('./'))
      ?? new Response('<h1>Sin conexión</h1><p>Vuelve a intentarlo.</p>', {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
  }
}

/**
 * Sirve del caché de inmediato y refresca en segundo plano.
 * @param {Request} request
 */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const network = fetch(request).then((response) => {
    // Las respuestas opacas y los errores no se cachean: envenenarían el
    // caché con contenido que no podemos validar.
    if (response && response.ok && response.type === 'basic') {
      void cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);

  if (cached) {
    void network;
    return cached;
  }
  const response = await network;
  return response ?? new Response('', { status: 504, statusText: 'Sin conexión' });
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
