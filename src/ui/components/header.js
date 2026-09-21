/**
 * @module ui/components/header
 * Barra superior: fecha, progreso del día, racha y escudos.
 *
 * Contrato de componente usado en todo el proyecto:
 *   create*(deps) -> { el: HTMLElement, update(state): void, destroy(): void }
 * El componente construye su DOM una sola vez y `update` sólo escribe texto y
 * atributos: no se reconstruyen nodos en cada render.
 */

import { h, svg } from '../dom.js';
import { formatLongDate } from '../../core/dateUtils.js';
import { headerModel } from '../../domain/selectors.js';
import { STREAK_CONFIG, DAY_OUTCOME } from '../../core/constants.js';
import { daysToNextShield } from '../../domain/streakCalculator.js';

const RING_RADIUS = 26;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * @returns {{el: HTMLElement, update: (state: import('../../core/store.js').AppState) => void, destroy: () => void}}
 */
export function createHeader() {
  const dateEl = h('p', { class: 'header__date' });
  const summaryEl = h('p', { class: 'header__summary' });

  const ringTrack = svg('circle', {
    class: 'ring__track', cx: 32, cy: 32, r: RING_RADIUS, 'stroke-width': 6, fill: 'none',
  });
  const ringValue = svg('circle', {
    class: 'ring__value',
    cx: 32, cy: 32, r: RING_RADIUS, 'stroke-width': 6, fill: 'none',
    'stroke-dasharray': RING_CIRCUMFERENCE.toFixed(2),
    'stroke-dashoffset': RING_CIRCUMFERENCE.toFixed(2),
    'stroke-linecap': 'round',
    transform: 'rotate(-90 32 32)',
  });
  const ringLabel = h('span', { class: 'ring__label', text: '0%' });
  const ring = h('div', { class: 'ring', role: 'img', 'aria-label': 'Progreso del día' }, [
    svg('svg', { viewBox: '0 0 64 64', 'aria-hidden': 'true', width: 64, height: 64 }, [ringTrack, ringValue]),
    ringLabel,
  ]);

  const streakValue = h('strong', { class: 'stat__value', text: '0' });
  const streakUnit = h('span', { class: 'stat__unit', text: 'días' });
  const shieldsEl = h('span', { class: 'stat__shields', 'aria-hidden': 'true' });
  const shieldsSr = h('span', { class: 'sr-only' });
  const consistencyEl = h('span', { class: 'stat__score' });

  const el = h('header', { class: 'header', role: 'banner' }, [
    h('div', { class: 'header__top' }, [
      h('div', { class: 'header__titles' }, [
        h('h1', { class: 'header__title', text: 'RoutineTracker' }),
        dateEl,
      ]),
      ring,
    ]),
    summaryEl,
    h('dl', { class: 'header__stats' }, [
      h('div', { class: 'stat' }, [
        h('dt', { class: 'stat__label', text: '🔥 Racha' }),
        h('dd', { class: 'stat__body' }, [streakValue, streakUnit]),
      ]),
      h('div', { class: 'stat' }, [
        h('dt', { class: 'stat__label', text: '🛡️ Escudos' }),
        h('dd', { class: 'stat__body' }, [shieldsEl, shieldsSr]),
      ]),
      h('div', { class: 'stat' }, [
        h('dt', { class: 'stat__label', text: '📈 Consistencia' }),
        h('dd', { class: 'stat__body' }, [consistencyEl]),
      ]),
    ]),
  ]);

  /** @param {import('../../core/store.js').AppState} state */
  function update(state) {
    const model = headerModel(state);
    dateEl.textContent = capitalize(formatLongDate(model.date));

    const { percent, completed, computable, skipped } = model.progress;
    ringValue.setAttribute('stroke-dashoffset', (RING_CIRCUMFERENCE * (1 - model.progress.ratio)).toFixed(2));
    ringLabel.textContent = `${percent}%`;
    ring.setAttribute('aria-label', `Progreso del día: ${percent} por ciento`);
    el.dataset.outcome = model.progress.outcome;

    summaryEl.textContent = buildSummary(model, completed, computable, skipped);

    streakValue.textContent = String(model.streak.currentStreak);
    streakUnit.textContent = model.streak.currentStreak === 1 ? 'día' : 'días';
    el.classList.toggle('header--at-risk', model.projection.atRisk);

    const shields = model.streak.shieldsAvailable;
    shieldsEl.textContent = '🛡️'.repeat(shields) + '·'.repeat(Math.max(0, STREAK_CONFIG.MAX_SHIELDS - shields));
    const pending = daysToNextShield(model.streak);
    shieldsSr.textContent = pending === null
      ? `${shields} escudos, máximo alcanzado`
      : `${shields} escudos, siguiente en ${pending} días`;
    shieldsEl.title = pending === null
      ? 'Escudos al máximo'
      : `Siguiente escudo en ${pending} ${pending === 1 ? 'día' : 'días'}`;

    consistencyEl.textContent = `${model.streak.weightedConsistencyScore.toFixed(1)}`;
  }

  return { el, update, destroy() {} };
}

function buildSummary(model, completed, computable, skipped) {
  if (model.isVoid) return 'Sin tareas para hoy. Añade una para empezar.';
  if (model.allDone) return `¡Día completo! ${completed} de ${computable} tareas.`;
  const remaining = model.projection.remainingForSuccess;
  const skippedNote = skipped > 0 ? ` · ${skipped} dispensada${skipped === 1 ? '' : 's'}` : '';
  if (model.progress.outcome === DAY_OUTCOME.SUCCESS) {
    return `${completed}/${computable} · objetivo diario cumplido${skippedNote}`;
  }
  return `${completed}/${computable} · ${remaining} más para asegurar el día${skippedNote}`;
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
