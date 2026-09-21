/**
 * @module ui/components/touchTaskItem
 * Capa de interacción táctil de un ítem de tarea: traduce el gesto en acción,
 * dirige la respuesta visual progresiva y dispara la háptica.
 *
 * Está separada de `taskItem.js` a propósito: aquel componente se ocupa de
 * *qué* se muestra (título, estado, hora de completado) y éste de *cómo se
 * siente* (seguimiento del dedo, umbral de disparo, vibración, fricción). Son
 * dos ejes de cambio distintos —el diseño visual y el ajuste fino del gesto—
 * y mezclarlos obligaba a releer el render entero para tocar un umbral.
 *
 * ## Contrato visual con el CSS
 *
 * Esta capa no aplica estilos: publica estado en el anfitrión y el CSS decide.
 *
 *   `data-swipe="complete" | "skip"`  dirección activa del gesto
 *   `data-armed="1"`                  se superó el umbral: soltar dispara
 *   `--swipe-progress: 0 … 1`         avance hacia el umbral (fondo e icono)
 *   `--swipe-overshoot: 0 … 1`        exceso por encima del umbral
 *
 * ## Umbrales
 *
 *   Disparo          35 % del ancho del ítem, o *fling* ≥ 0,45 px/ms
 *   Fricción         a partir del 50 % del ancho (logarítmica, en `gestures.js`)
 *   Háptica          una sola vibración al **entrar** en zona de disparo
 */

import { attachSwipe } from '../../platform/gestures.js';
import { GESTURE_CONFIG } from '../../core/constants.js';
import { prefersReducedMotion } from '../dom.js';

/** Dirección del gesto → acción. */
const DIRECTION = Object.freeze({
  RIGHT: 1,
  LEFT: -1,
});

/**
 * @param {{
 *   host: HTMLElement,
 *   surface: HTMLElement,
 *   getModel: () => {task: import('../../domain/taskValidator.js').TaskDefinition,
 *                    record: import('../../domain/taskValidator.js').TaskExecutionRecord},
 *   onComplete: (completed: boolean) => void,
 *   onSkip: (skipped: boolean) => void,
 *   onTap: () => void,
 *   haptics?: import('../../platform/haptics.js').Haptics,
 * }} options
 * @returns {{destroy: () => void, reset: () => void}}
 */
export function attachTaskGestures({ host, surface, getModel, onComplete, onSkip, onTap, haptics }) {
  let armed = false;

  const swipe = attachSwipe(surface, {
    onPanStart: ({ direction }) => {
      surface.classList.add('is-panning');
      surface.style.transition = 'none';
      host.dataset.swipe = direction > 0 ? 'complete' : 'skip';
    },

    onPan: ({ dx, ratio, direction, width }) => {
      // Sólo `transform`: mover con `left` o `margin` dispararía layout en
      // cada frame del arrastre.
      surface.style.transform = `translate3d(${dx}px, 0, 0)`;
      host.dataset.swipe = direction > 0 ? 'complete' : 'skip';
      host.style.setProperty('--swipe-progress', ratio.toFixed(3));
      host.style.setProperty('--swipe-overshoot', overshoot(dx, width).toFixed(3));

      // La vibración marca el instante exacto en que soltar ya dispararía la
      // acción: es la confirmación que el usuario no puede leer mientras su
      // propio pulgar tapa la fila.
      if (ratio >= 1 && !armed) {
        armed = true;
        host.dataset.armed = '1';
        haptics?.fire('TAP');
      } else if (ratio < 1 && armed) {
        armed = false;
        delete host.dataset.armed;
      }
    },

    onCommit: ({ direction }) => {
      const { record } = getModel();
      reset();
      if (direction === DIRECTION.RIGHT) {
        haptics?.fire(record.completed ? 'UNDO' : 'COMPLETE');
        onComplete(!record.completed);
      } else {
        haptics?.fire('SKIP');
        onSkip(!record.skipped);
      }
    },

    onCancel: reset,

    onTap: (context) => {
      // Los botones internos traen su propio manejador.
      if (context.target instanceof Element && context.target.closest('button')) return;
      const { record } = getModel();
      haptics?.fire(record.completed ? 'UNDO' : 'COMPLETE');
      onTap();
    },
  });

  /** Devuelve la superficie a su posición de reposo. */
  function reset() {
    armed = false;
    surface.classList.remove('is-panning');
    surface.style.transition = prefersReducedMotion()
      ? 'none'
      : `transform ${GESTURE_CONFIG.SETTLE_MS}ms cubic-bezier(.22,.61,.36,1)`;
    surface.style.transform = 'translate3d(0, 0, 0)';
    host.style.setProperty('--swipe-progress', '0');
    host.style.setProperty('--swipe-overshoot', '0');
    delete host.dataset.swipe;
    delete host.dataset.armed;
  }

  return {
    reset,
    destroy() {
      swipe.destroy();
    },
  };
}

/**
 * Exceso normalizado por encima del umbral de disparo: el tramo que va del
 * 35 % (disparo) al 50 % (inicio de la fricción) del ancho del ítem. Existe
 * porque `--swipe-progress` satura en 1 y el CSS se quedaría sin señal justo
 * cuando el gesto entra en su fase más expresiva.
 * @param {number} dx    desplazamiento aplicado, en px.
 * @param {number} width ancho del elemento, en px.
 * @returns {number} 0 … 1
 */
export function overshoot(dx, width) {
  const commitPx = width * GESTURE_CONFIG.COMMIT_RATIO;
  const frictionPx = width * GESTURE_CONFIG.FRICTION_RATIO;
  const span = Math.max(1, frictionPx - commitPx);
  return Math.min(1, Math.max(0, (Math.abs(dx) - commitPx) / span));
}
