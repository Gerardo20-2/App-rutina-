/**
 * @module ui/components/toast
 * Avisos efímeros. Región `aria-live="polite"`: los mensajes se anuncian sin
 * interrumpir al lector de pantalla y sin robar el foco.
 */

import { h } from '../dom.js';
import { EVENTS } from '../../core/constants.js';

const DEFAULT_TIMEOUT = 3200;

/** @param {import('../../core/events.js').EventBus} bus */
export function createToaster(bus) {
  const el = h('div', { class: 'toaster', role: 'status', 'aria-live': 'polite' });
  /** @type {Map<HTMLElement, number>} */
  const timers = new Map();

  /**
   * @param {{message: string, tone?: 'info'|'success'|'error', timeout?: number, action?: {label: string, onClick: () => void}}} options
   */
  function show({ message, tone = 'info', timeout = DEFAULT_TIMEOUT, action }) {
    if (!message) return;
    const toast = h('div', { class: `toast toast--${tone}` }, [
      h('span', { class: 'toast__text', text: message }),
      action ? h('button', {
        class: 'toast__action', type: 'button', text: action.label,
        onClick: () => {
          action.onClick();
          dismiss(toast);
        },
      }) : null,
    ]);
    el.appendChild(toast);
    // Deja que el nodo entre en el árbol antes de animar la aparición.
    requestAnimationFrame(() => toast.classList.add('is-visible'));
    timers.set(toast, setTimeout(() => dismiss(toast), timeout));
  }

  function dismiss(toast) {
    const timer = timers.get(toast);
    if (timer) clearTimeout(timer);
    timers.delete(toast);
    toast.classList.remove('is-visible');
    setTimeout(() => toast.remove(), 200);
  }

  const unsubscribe = bus.on(EVENTS.TOAST, show);

  return {
    el,
    show,
    update() {},
    destroy() {
      unsubscribe();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
