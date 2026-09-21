/**
 * @module ui/components/taskItem
 * Ítem de tarea: presentación, estado y accesibilidad. El gesto en sí vive en
 * `touchTaskItem.js`; aquí sólo se decide qué se ve.
 *
 *   swipe →  completar / descompletar
 *   swipe ←  dispensar (skip): la tarea sale del denominador del día
 *   tap      alterna completado
 *   botón ⋯  abre el editor
 *
 * ## UI optimista
 *
 * El estado visual se aplica **en el frame del gesto**, antes de que la
 * transacción de IndexedDB resuelva. Una escritura tarda entre 5 y 60 ms en
 * un móvil con la batería baja, y esperar a confirmarla rompe la ilusión de
 * respuesta directa que sostiene un gesto táctil. Si la escritura falla, el
 * servicio revierte el estado y el siguiente render devuelve la fila a su
 * sitio: el error es visible, pero el caso normal es instantáneo.
 *
 * El gesto sólo transforma la capa `task__surface`; el fondo con los iconos de
 * acción permanece fijo, que es lo que produce la sensación de "revelar" en
 * lugar de "arrastrar la fila entera".
 */

import { h } from '../dom.js';
import { attachTaskGestures } from './touchTaskItem.js';

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
      haptics?.fire(record.completed ? 'UNDO' : 'COMPLETE');
      commitComplete(!record.completed);
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
      h('span', { class: 'task__affordance task__affordance--complete' }, [
        h('span', { class: 'task__affordance-icon', text: '✓' }),
        h('span', { class: 'task__affordance-text', text: 'Completar' }),
      ]),
      h('span', { class: 'task__affordance task__affordance--skip' }, [
        h('span', { class: 'task__affordance-text', text: 'Hoy no' }),
        h('span', { class: 'task__affordance-icon', text: '⤼' }),
      ]),
    ]),
    surface,
  ]);

  const gestures = attachTaskGestures({
    host: el,
    surface,
    haptics,
    getModel: () => ({ task, record }),
    onComplete: (completed) => commitComplete(completed),
    onSkip: (skipped) => commitSkip(skipped),
    onTap: () => commitComplete(!record.completed),
  });

  /**
   * Pinta el nuevo estado ya y despacha la escritura después.
   * @param {boolean} completed
   */
  function commitComplete(completed) {
    applyVisualState({ completed, skipped: false });
    onToggle(task.id);
  }

  /** @param {boolean} skipped */
  function commitSkip(skipped) {
    applyVisualState({ completed: false, skipped });
    onSkip(task.id);
  }

  /**
   * Estado visual inmediato, sin esperar a la persistencia. No toca `record`:
   * la verdad sigue siendo el store, y el siguiente `update()` reconcilia (o
   * revierte, si la escritura falló).
   * @param {{completed: boolean, skipped: boolean}} next
   */
  function applyVisualState(next) {
    el.classList.toggle('task--done', next.completed);
    el.classList.toggle('task--skipped', next.skipped);
    el.classList.add('task--pending-write');
    check.setAttribute('aria-pressed', String(next.completed));
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
    el.classList.remove('task--pending-write');
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
      gestures.destroy();
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
