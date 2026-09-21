/**
 * @module ui/components/taskItem
 * Ítem de tarea: checkbox accesible, gestos táctiles y retorno háptico.
 *
 *   swipe →  completar / descompletar
 *   swipe ←  dispensar (skip): la tarea sale del denominador del día
 *   tap      alterna completado
 *   botón ⋯  abre el editor
 *
 * El gesto sólo transforma la capa `task__surface`; el fondo con los iconos de
 * acción permanece fijo, que es lo que produce la sensación de "revelar" en
 * lugar de "arrastrar la fila entera".
 */

import { h } from '../dom.js';
import { attachSwipe } from '../../platform/gestures.js';
import { GESTURE_CONFIG } from '../../core/constants.js';
import { prefersReducedMotion } from '../dom.js';

/**
 * @param {{
 *   task: import('../../domain/taskValidator.js').TaskDefinition,
 *   record: import('../../domain/taskValidator.js').TaskExecutionRecord,
 *   onToggle: (id: string) => void,
 *   onSkip: (id: string) => void,
 *   onEdit: (id: string) => void,
 *   haptics?: import('../../platform/haptics.js').Haptics,
 * }} options
 */
export function createTaskItem(options) {
  const { onToggle, onSkip, onEdit, haptics } = options;
  let task = options.task;
  let record = options.record;

  const check = h('button', {
    class: 'task__check',
    type: 'button',
    'aria-pressed': String(Boolean(record.completed)),
    onClick: (event) => {
      event.stopPropagation();
      onToggle(task.id);
    },
  }, [h('span', { class: 'task__check-mark', 'aria-hidden': 'true', text: '✓' })]);

  const title = h('span', { class: 'task__title', text: task.title });
  const meta = h('span', { class: 'task__meta' });
  const body = h('div', { class: 'task__body' }, [title, meta]);

  const editBtn = h('button', {
    class: 'task__edit',
    type: 'button',
    'aria-label': `Editar «${task.title}»`,
    onClick: (event) => {
      event.stopPropagation();
      onEdit(task.id);
    },
  }, [h('span', { 'aria-hidden': 'true', text: '⋯' })]);

  const surface = h('div', { class: 'task__surface' }, [check, body, editBtn]);

  const el = h('li', {
    class: 'task',
    dataset: { id: task.id, section: task.section },
  }, [
    h('div', { class: 'task__affordances', 'aria-hidden': 'true' }, [
      h('span', { class: 'task__affordance task__affordance--complete', text: '✓ Completar' }),
      h('span', { class: 'task__affordance task__affordance--skip', text: 'Dispensar ✕' }),
    ]),
    surface,
  ]);

  // El tap lo gestiona el reconocedor (no un click): así un arrastre que
  // termina sobre el botón no dispara además el click del navegador.
  const swipe = attachSwipe(surface, {
    onPanStart: () => {
      surface.classList.add('is-panning');
      surface.style.transition = 'none';
    },
    onPan: ({ dx, ratio, direction }) => {
      surface.style.transform = `translate3d(${dx}px, 0, 0)`;
      el.dataset.swipe = direction > 0 ? 'complete' : 'skip';
      el.style.setProperty('--swipe-progress', ratio.toFixed(3));
      if (ratio >= 1 && !el.dataset.armed) {
        el.dataset.armed = '1';
        haptics?.fire('TAP');
      } else if (ratio < 1 && el.dataset.armed) {
        delete el.dataset.armed;
      }
    },
    onCommit: ({ direction }) => {
      settle();
      if (direction > 0) {
        haptics?.fire(record.completed ? 'UNDO' : 'COMPLETE');
        onToggle(task.id);
      } else {
        haptics?.fire('SKIP');
        onSkip(task.id);
      }
    },
    onCancel: settle,
    onTap: (ctx) => {
      // Los botones internos ya tienen su propio manejador.
      if (ctx.target instanceof Element && ctx.target.closest('button')) return;
      haptics?.fire(record.completed ? 'UNDO' : 'COMPLETE');
      onToggle(task.id);
    },
  });

  function settle() {
    surface.classList.remove('is-panning');
    surface.style.transition = prefersReducedMotion()
      ? 'none'
      : `transform ${GESTURE_CONFIG.SETTLE_MS}ms cubic-bezier(.22,.61,.36,1)`;
    surface.style.transform = 'translate3d(0, 0, 0)';
    el.style.setProperty('--swipe-progress', '0');
    delete el.dataset.swipe;
    delete el.dataset.armed;
  }

  /**
   * @param {{task: import('../../domain/taskValidator.js').TaskDefinition,
   *          record: import('../../domain/taskValidator.js').TaskExecutionRecord}} next
   */
  function update(next) {
    const titleChanged = next.task.title !== task.title;
    task = next.task;
    record = next.record;

    if (titleChanged) {
      title.textContent = task.title;
      editBtn.setAttribute('aria-label', `Editar «${task.title}»`);
    }
    el.dataset.section = task.section;
    el.classList.toggle('task--done', Boolean(record.completed));
    el.classList.toggle('task--skipped', Boolean(record.skipped));
    check.setAttribute('aria-pressed', String(Boolean(record.completed)));
    check.setAttribute('aria-label', record.completed
      ? `Marcar «${task.title}» como pendiente`
      : `Completar «${task.title}»`);
    meta.textContent = buildMeta(task, record);
  }

  update({ task, record });

  return {
    el,
    update,
    destroy() {
      swipe.destroy();
    },
  };
}

function buildMeta(task, record) {
  if (record.skipped) return 'Dispensada hoy';
  if (record.completed && record.completedAt) {
    const time = new Date(record.completedAt);
    return Number.isNaN(time.getTime())
      ? 'Completada'
      : `Completada · ${time.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
  }
  return task.estimatedMinutes > 0 ? `${task.estimatedMinutes} min` : 'Sin duración estimada';
}
