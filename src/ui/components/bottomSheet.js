/**
 * @module ui/components/bottomSheet
 * Hoja deslizante desde el borde inferior: el contenedor de toda interacción
 * secundaria de la aplicación (alta y edición de tareas, ajustes, histórico).
 *
 * Sustituye a los diálogos centrados. En un móvil de 6,1"–6,7" sujetado con
 * una mano, un modal centrado sitúa sus controles en la mitad superior de la
 * pantalla, fuera del arco natural del pulgar; una hoja inferior los coloca
 * exactamente donde el pulgar ya está, y además ofrece un gesto de cierre
 * (arrastrar hacia abajo) que no exige apuntar a un botón pequeño.
 *
 * ## Máquina de estados
 *
 *   CLOSED ──open()──▶ OPENING ──transitionend──▶ OPEN
 *   OPEN ──pointerdown en el asa o cabecera──▶ DRAGGING
 *   DRAGGING ──dy ≥ 30 % de la altura, o velocidad ≥ 0,5 px/ms──▶ CLOSING
 *   DRAGGING ──por debajo del umbral──▶ OPEN (vuelve a su sitio)
 *   OPEN ──Escape | clic en el fondo | close()──▶ CLOSING ──▶ CLOSED
 *
 * Accesibilidad: `role="dialog"` + `aria-modal`, foco atrapado mientras está
 * abierta, devolución del foco al elemento que la abrió y bloqueo del scroll
 * de fondo.
 */

import { h } from '../dom.js';
import { SHEET_CONFIG } from '../../core/constants.js';
import { prefersReducedMotion } from '../dom.js';

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

/** @type {number} Hojas abiertas: el scroll de fondo se libera con la última. */
let openSheets = 0;

/**
 * @param {{id: string, title: string, description?: string, onClose?: () => void}} options
 */
export function createBottomSheet({ id, title, description, onClose }) {
  const titleId = `${id}-title`;

  const handle = h('div', { class: 'sheet__handle', 'aria-hidden': 'true' });
  const heading = h('h2', { class: 'sheet__title', id: titleId, text: title });
  const closeBtn = h('button', {
    class: 'sheet__close', type: 'button', 'aria-label': `Cerrar ${title.toLowerCase()}`,
    onClick: () => close(),
  }, [h('span', { 'aria-hidden': 'true', text: '✕' })]);

  const header = h('div', { class: 'sheet__header' }, [handle, h('div', { class: 'sheet__bar' }, [heading, closeBtn])]);
  const body = h('div', { class: 'sheet__body' });

  const panel = h('div', {
    class: 'sheet__panel',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': titleId,
    'aria-describedby': description ? `${id}-desc` : null,
  }, [
    header,
    description ? h('p', { class: 'sheet__description', id: `${id}-desc`, text: description }) : null,
    body,
  ]);

  const backdrop = h('div', { class: 'sheet__backdrop', 'aria-hidden': 'true' });
  const el = h('div', { class: 'sheet', id, hidden: true }, [backdrop, panel]);

  /** @type {Element|null} */
  let opener = null;
  let state = 'CLOSED';
  let dragPointerId = null;
  let dragStartY = 0;
  let dragLastY = 0;
  let dragLastTime = 0;
  let dragVelocity = 0;
  /** Desplazamiento que ya tenía el panel al empezar el arrastre. */
  let dragBaseOffset = 0;

  backdrop.addEventListener('pointerdown', () => close());

  el.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    // Trampa de foco: sin ella, tabular saca al usuario a la página de detrás,
    // que está oculta a efectos prácticos pero sigue siendo enfocable.
    const focusables = [...panel.querySelectorAll(FOCUSABLE)].filter(isVisible);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  // Arrastre vertical para cerrar. Sólo desde la cabecera: si se escuchara en
  // todo el panel, un scroll dentro del contenido arrastraría la hoja entera.
  header.addEventListener('pointerdown', (event) => {
    if (state !== 'OPEN') return;
    if (event.target instanceof Element && event.target.closest('button')) return;
    dragPointerId = event.pointerId;
    dragStartY = dragLastY = event.clientY;
    dragLastTime = event.timeStamp;
    dragVelocity = 0;
    // El usuario puede agarrar la hoja mientras aún está entrando. Partir de
    // su desplazamiento real, y no de cero, evita el salto visual y hace que
    // el umbral de cierre se mida sobre la posición que el usuario ve.
    dragBaseOffset = currentTranslateY(panel);
    state = 'DRAGGING';
    panel.style.transition = 'none';
    try {
      header.setPointerCapture(event.pointerId);
    } catch { /* noop */ }
  });

  header.addEventListener('pointermove', (event) => {
    if (state !== 'DRAGGING' || event.pointerId !== dragPointerId) return;
    const raw = dragBaseOffset + (event.clientY - dragStartY);
    const elapsed = Math.max(1, event.timeStamp - dragLastTime);
    dragVelocity = 0.7 * ((event.clientY - dragLastY) / elapsed) + 0.3 * dragVelocity;
    dragLastY = event.clientY;
    dragLastTime = event.timeStamp;
    // Hacia arriba la hoja no sube: resistencia fuerte para que se note el tope.
    const offset = raw >= 0 ? raw : raw * SHEET_CONFIG.UPWARD_RESISTANCE;
    panel.style.transform = `translate3d(0, ${offset}px, 0)`;
    backdrop.style.opacity = String(Math.max(0, 1 - Math.max(0, offset) / panel.offsetHeight));
  });

  const endDrag = (event) => {
    if (state !== 'DRAGGING' || (dragPointerId !== null && event.pointerId !== dragPointerId)) return;
    const travelled = dragBaseOffset + (event.clientY - dragStartY);
    dragPointerId = null;
    panel.style.transition = '';
    backdrop.style.opacity = '';

    const farEnough = travelled >= panel.offsetHeight * SHEET_CONFIG.DISMISS_RATIO;
    const fastEnough = dragVelocity >= SHEET_CONFIG.DISMISS_VELOCITY
      && travelled > SHEET_CONFIG.DISMISS_MIN_PX;
    if (farEnough || fastEnough) {
      state = 'OPEN'; // close() exige estar abierta
      close();
    } else {
      state = 'OPEN';
      panel.style.transform = '';
    }
  };
  header.addEventListener('pointerup', endDrag);
  header.addEventListener('pointercancel', endDrag);

  /** @param {Node|Node[]} content */
  function setContent(content) {
    const nodes = Array.isArray(content) ? content : [content];
    body.replaceChildren(...nodes);
  }

  /** @param {Element} [trigger] elemento que abre la hoja (recibe el foco al cerrar). */
  function open(trigger) {
    if (state === 'OPEN' || state === 'OPENING') return;
    opener = trigger ?? (document.activeElement instanceof Element ? document.activeElement : null);
    el.hidden = false;
    panel.style.transform = '';
    state = 'OPENING';

    openSheets += 1;
    document.documentElement.classList.add('has-sheet');

    // Un frame con la hoja montada pero sin la clase: sin él, la transición de
    // entrada no llega a ejecutarse porque el estado inicial no se ha pintado.
    requestAnimationFrame(() => {
      el.classList.add('is-open');
      state = 'OPEN';
      const target = panel.querySelector(FOCUSABLE);
      if (target instanceof HTMLElement) target.focus({ preventScroll: true });
      else panel.focus?.({ preventScroll: true });
    });
  }

  function close() {
    if (state === 'CLOSED' || state === 'CLOSING') return;
    state = 'CLOSING';
    el.classList.remove('is-open');

    openSheets = Math.max(0, openSheets - 1);
    if (openSheets === 0) document.documentElement.classList.remove('has-sheet');

    const finish = () => {
      if (state !== 'CLOSING') return;
      el.hidden = true;
      panel.style.transform = '';
      state = 'CLOSED';
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus({ preventScroll: true });
      opener = null;
      onClose?.();
    };

    if (prefersReducedMotion()) finish();
    else setTimeout(finish, SHEET_CONFIG.TRANSITION_MS);
  }

  return {
    el,
    body,
    setContent,
    open,
    close,
    get isOpen() {
      return state === 'OPEN' || state === 'OPENING';
    },
    /** @param {string} value */
    setTitle(value) {
      heading.textContent = value;
      closeBtn.setAttribute('aria-label', `Cerrar ${value.toLowerCase()}`);
    },
    update() {},
    destroy() {
      if (state !== 'CLOSED') {
        openSheets = Math.max(0, openSheets - 1);
        if (openSheets === 0) document.documentElement.classList.remove('has-sheet');
      }
      el.remove();
    },
  };
}

/**
 * Desplazamiento vertical actual de un elemento, leyendo la matriz de su
 * `transform` computado (sirve también a mitad de una transición).
 * @param {HTMLElement} el
 * @returns {number} px.
 */
function currentTranslateY(el) {
  const transform = getComputedStyle(el).transform;
  if (!transform || transform === 'none') return 0;
  try {
    return new DOMMatrixReadOnly(transform).m42;
  } catch {
    return 0;
  }
}

/** @param {Element} node */
function isVisible(node) {
  return node instanceof HTMLElement && node.offsetParent !== null && !node.hasAttribute('hidden');
}
