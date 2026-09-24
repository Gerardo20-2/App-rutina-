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
 *   · Cross-origin   → rechazada con error de red. La app no depende de
 *                     ningún tercero: una petición a otro origen sólo puede
 *                     venir de código inyectado o de una extensión, y el
 *                     worker no la sirve ni la cachea.
 */

/* eslint-env serviceworker */

const CACHE_NAME = 'routine-tracker-v4';
const NAVIGATION_TIMEOUT_MS = 3000;

/**
 * Raíz efectiva de la aplicación. En GitHub Pages es `/<repo>/`, no `/`, así
 * que cualquier ruta absoluta daría 404. `registration.scope` es la única
 * fuente fiable: el worker puede haberse registrado bajo cualquier subruta.
 */
const APP_SCOPE = self.registration?.scope ?? new URL('./', self.location.href).href;

/**
 * Resuelve una ruta relativa contra la raíz de la aplicación.
 * @param {string} path
 * @returns {string} URL absoluta.
 */
function scoped(path) {
  return new URL(path, APP_SCOPE).href;
}

/** Shell mínimo para arrancar sin red, en rutas relativas a la raíz de la app. */
const ASSETS_TO_CACHE = [
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
  './src/domain/timeBlockService.js',
  './src/storage/storageAdapter.js',
  './src/storage/indexedDbService.js',
  './src/storage/localStorageService.js',
  './src/storage/repository.js',
  './src/storage/seedData.js',
  './src/security/cryptoService.js',
  './src/security/objectGuard.js',
  './src/platform/gestures.js',
  './src/platform/haptics.js',
  './src/platform/wakeLock.js',
  './src/ui/renderer.js',
  './src/ui/dom.js',
  './src/ui/components/bottomBar.js',
  './src/ui/components/bottomSheet.js',
  './src/ui/components/header.js',
  './src/ui/components/taskItem.js',
  './src/ui/components/touchTaskItem.js',
  './src/ui/components/taskList.js',
  './src/ui/components/heatmap.js',
  './src/ui/components/taskEditor.js',
  './src/ui/components/settingsPanel.js',
  './src/ui/components/toast.js',
  './src/ui/styles/base.css',
  './src/ui/styles/layout.css',
  './src/ui/styles/components.css',
];

/** El mismo shell, ya resuelto a URLs absolutas bajo la raíz de la app. */
const SCOPED_ASSETS = ASSETS_TO_CACHE.map(scoped);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // `addAll` es atómico: un 404 abortaría la instalación entera, así que
    // cada recurso se añade por separado y un fallo aislado no rompe el SW.
    await Promise.all(SCOPED_ASSETS.map(async (url) => {
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
  // Sin backend, nada legítimo envía POST/PUT: se deja al navegador (y a la CSP).
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    // Las navegaciones a otro sitio (un enlace que el usuario pulsa) no
    // llegan aquí: están fuera del alcance del worker. Lo que sí llega es un
    // subrecurso cruzado, y ninguno es legítimo en esta app.
    event.respondWith(Response.error());
    return;
  }
  // Fuera del alcance de la app (otra PWA en el mismo dominio de Pages) no
  // es asunto de este worker.
  if (!url.href.startsWith(APP_SCOPE)) return;

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
      if (isCacheable(preloaded)) void cache.put(scoped('./index.html'), preloaded.clone());
      return preloaded;
    }
    const response = await withTimeout(fetch(event.request), NAVIGATION_TIMEOUT_MS);
    if (isCacheable(response)) {
      void cache.put(scoped('./index.html'), response.clone());
    }
    return response;
  } catch {
    return (await cache.match(scoped('./index.html')))
      ?? (await cache.match(scoped('./')))
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
    if (isCacheable(response)) {
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
 * Sólo se cachean respuestas propias y completas: `basic` garantiza mismo
 * origen, y una redirección podría haber terminado en otro sitio.
 * @param {Response|null|undefined} response
 */
function isCacheable(response) {
  if (!response || !response.ok || response.type !== 'basic' || response.redirected) return false;
  try {
    return new URL(response.url).origin === self.location.origin;
  } catch {
    return false;
  }
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
