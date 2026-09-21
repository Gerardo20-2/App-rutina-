/**
 * @module ui/components/bottomBar
 * Barra de acciones fija en el borde inferior: el único lugar de la interfaz
 * con controles primarios.
 *
 * ## Zona del pulgar
 *
 * En un teléfono de 6,1"–6,7" sujetado con una mano, el pulgar barre cómodamente
 * el tercio inferior de la pantalla; la esquina superior opuesta exige recolocar
 * el agarre, que es justo cuando se cae el móvil. De ahí el reparto:
 *
 *   · Cabecera (arriba)  → **sólo lectura**: fecha, racha y anillo de progreso.
 *   · Barra (abajo)      → **toda acción**: añadir, histórico y ajustes.
 *
 * El botón central de añadir es el más frecuente y el más accesible: 56 × 56 px
 * centrados, elevados sobre la barra. Los accesos secundarios van a los
 * extremos, donde llegan tanto el pulgar derecho como el izquierdo.
 */

import { h } from '../dom.js';

/**
 * @param {{
 *   onCreate: (trigger: HTMLElement) => void,
 *   onHistory: (trigger: HTMLElement) => void,
 *   onSettings: (trigger: HTMLElement) => void,
 *   haptics?: import('../../platform/haptics.js').Haptics,
 * }} handlers
 */
export function createBottomBar(handlers) {
  const streakBadge = h('span', { class: 'bar__badge', hidden: true });

  const historyBtn = createBarButton({
    icon: '📊',
    label: 'Histórico',
    onClick: (event) => {
      handlers.haptics?.fire('TAP');
      handlers.onHistory(event.currentTarget);
    },
  });

  const settingsBtn = createBarButton({
    icon: '⚙️',
    label: 'Ajustes',
    onClick: (event) => {
      handlers.haptics?.fire('TAP');
      handlers.onSettings(event.currentTarget);
    },
  });

  const fab = h('button', {
    class: 'fab',
    type: 'button',
    'aria-label': 'Añadir tarea',
    onClick: (event) => {
      handlers.haptics?.fire('TAP');
      handlers.onCreate(event.currentTarget);
    },
  }, [h('span', { class: 'fab__icon', 'aria-hidden': 'true', text: '+' })]);

  const el = h('nav', { class: 'bar', 'aria-label': 'Acciones principales' }, [
    historyBtn.el,
    h('div', { class: 'bar__center' }, [fab, streakBadge]),
    settingsBtn.el,
  ]);

  /** @param {import('../../core/store.js').AppState} state */
  function update(state) {
    const streak = state.streak.currentStreak;
    streakBadge.hidden = streak <= 0;
    streakBadge.textContent = `🔥 ${streak}`;
    streakBadge.setAttribute('aria-hidden', 'true');
    el.dataset.busy = String(state.ui.busy);
  }

  return { el, update, focusCreate: () => fab.focus(), destroy() {} };
}

/**
 * @param {{icon: string, label: string, onClick: (event: MouseEvent) => void}} options
 */
function createBarButton({ icon, label, onClick }) {
  const el = h('button', { class: 'bar__btn', type: 'button', onClick }, [
    h('span', { class: 'bar__icon', 'aria-hidden': 'true', text: icon }),
    h('span', { class: 'bar__label', text: label }),
  ]);
  return { el };
}
