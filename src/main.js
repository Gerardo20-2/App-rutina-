/**
 * @module main
 * Punto de entrada: compone los módulos, hidrata el estado y arranca la UI.
 *
 * Secuencia de arranque:
 *   1. Abrir la persistencia (IndexedDB → localStorage → memoria).
 *   2. Hidratar el store y montar la interfaz (primer pintado útil).
 *   3. Comprobar el corte de medianoche (la app pudo quedar abierta días).
 *   4. Registrar el Service Worker — deliberadamente al final: la caché no
 *      debe competir por ancho de banda con el primer render.
 */

import { store } from './core/store.js';
import { bus } from './core/events.js';
import { EVENTS } from './core/constants.js';
import { repository } from './storage/repository.js';
import { RoutineService } from './domain/routineService.js';
import { DayResetService } from './domain/dayResetService.js';
import { createRenderer } from './ui/renderer.js';
import { haptics } from './platform/haptics.js';
import { wakeLock } from './platform/wakeLock.js';

const root = document.getElementById('app');

async function bootstrap() {
  if (!root) throw new Error('No se encontró el contenedor #app');

  await repository.open();

  const service = new RoutineService({ repository, store, bus });
  await service.hydrate();

  const renderer = createRenderer({ root, store, bus, service, haptics, wakeLock });
  renderer.mount();

  const dayReset = new DayResetService({ repository, store, bus });
  // Se comprueba ANTES de arrancar el temporizador: si la app estuvo cerrada
  // varios días, el corte pendiente se resuelve en el arranque.
  await dayReset.check('bootstrap');
  dayReset.start();

  if (repository.diagnostics.legacyMigrated) {
    bus.emit(EVENTS.TOAST, { message: 'Datos de la versión anterior migrados', tone: 'success' });
  }
  if (repository.engine === 'memory') {
    bus.emit(EVENTS.TOAST, {
      message: 'Almacenamiento no disponible: los cambios no se guardarán',
      tone: 'error',
      timeout: 8000,
    });
  }

  registerServiceWorker();
  exposeDebugHandle({ service, dayReset });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) return;

  // El arranque es asíncrono, así que `load` puede haber disparado ya: engancharse
  // al evento sin comprobar `readyState` dejaría la app sin Service Worker.
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });

  function register() {
    // Rutas relativas al documento, nunca absolutas: en GitHub Pages la app
    // cuelga de `/<repo>/`, así que `/sw.js` daría 404. El scope explícito
    // `./` deja constancia de la intención y coincide con el máximo alcance
    // permitido para un worker servido desde la raíz de la aplicación.
    const swPath = './sw.js';
    navigator.serviceWorker.register(swPath, { scope: './' }).then((registration) => {
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            bus.emit(EVENTS.TOAST, {
              message: 'Nueva versión disponible',
              tone: 'info',
              timeout: 10_000,
              action: { label: 'Actualizar', onClick: () => {
                installing.postMessage({ type: 'SKIP_WAITING' });
                location.reload();
              } },
            });
          }
        });
      });
    }).catch((error) => console.warn('[SW] registro fallido', error));
  }
}

/** Handle de depuración accesible desde la consola del navegador. */
function exposeDebugHandle(extra) {
  Object.defineProperty(globalThis, '__routineTracker', {
    value: { store, bus, repository, ...extra },
    writable: false,
    configurable: true,
  });
}

bootstrap().catch((error) => {
  console.error('[main] arranque fallido', error);
  if (!root) return;
  root.replaceChildren();
  const fallback = document.createElement('div');
  fallback.className = 'boot-error';
  const title = document.createElement('h1');
  title.textContent = 'No se pudo iniciar RoutineTracker';
  const detail = document.createElement('p');
  detail.textContent = error?.message ?? 'Error desconocido';
  const retry = document.createElement('button');
  retry.className = 'btn btn--primary';
  retry.textContent = 'Reintentar';
  retry.addEventListener('click', () => location.reload());
  fallback.append(title, detail, retry);
  root.appendChild(fallback);
});
