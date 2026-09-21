/**
 * @module ui/components/taskEditor
 * Modal de alta/edición de tareas sobre `<dialog>` nativo (foco atrapado,
 * cierre con Escape y capa de fondo sin coste en JavaScript).
 *
 * Si el navegador no implementa `showModal`, el diálogo degrada a un panel
 * posicionado con CSS mediante el atributo `open`.
 */

import { h } from '../dom.js';
import { SECTION_ORDER, SECTION_META, LIMITS } from '../../core/constants.js';
import { ValidationError } from '../../domain/taskValidator.js';

/**
 * @param {{
 *   onSubmit: (values: {id?: string, title: string, section: string, estimatedMinutes: number}) => Promise<void>,
 *   onArchive: (id: string) => Promise<void>,
 * }} handlers
 */
export function createTaskEditor(handlers) {
  const titleInput = h('input', {
    class: 'field__input', id: 'task-title', name: 'title', type: 'text',
    required: true, maxlength: String(LIMITS.TASK_TITLE_MAX), autocomplete: 'off',
    placeholder: 'Meditación 10 min',
  });

  const sectionSelect = h('select', { class: 'field__input', id: 'task-section', name: 'section' },
    SECTION_ORDER.map((section) => h('option', {
      value: section,
      text: `${SECTION_META[section].icon}  ${SECTION_META[section].label}`,
    })));

  const minutesInput = h('input', {
    class: 'field__input', id: 'task-minutes', name: 'estimatedMinutes', type: 'number',
    min: '0', max: String(LIMITS.TASK_MINUTES_MAX), step: '1', inputmode: 'numeric', value: '5',
  });

  const errorEl = h('p', { class: 'field__error', role: 'alert' });
  const heading = h('h2', { class: 'dialog__title', id: 'editor-title', text: 'Nueva tarea' });

  const archiveBtn = h('button', {
    class: 'btn btn--danger', type: 'button', hidden: true, text: 'Archivar',
    onClick: async () => {
      if (!currentId) return;
      await handlers.onArchive(currentId);
      close();
    },
  });

  const form = h('form', { class: 'dialog__form', method: 'dialog', novalidate: true }, [
    h('div', { class: 'field' }, [
      h('label', { class: 'field__label', for: 'task-title', text: 'Título' }),
      titleInput,
    ]),
    h('div', { class: 'field-row' }, [
      h('div', { class: 'field' }, [
        h('label', { class: 'field__label', for: 'task-section', text: 'Bloque' }),
        sectionSelect,
      ]),
      h('div', { class: 'field' }, [
        h('label', { class: 'field__label', for: 'task-minutes', text: 'Minutos' }),
        minutesInput,
      ]),
    ]),
    errorEl,
    h('div', { class: 'dialog__actions' }, [
      archiveBtn,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', type: 'button', text: 'Cancelar', onClick: () => close() }),
      h('button', { class: 'btn btn--primary', type: 'submit', text: 'Guardar' }),
    ]),
  ]);

  const el = h('dialog', { class: 'dialog', 'aria-labelledby': 'editor-title' }, [
    h('div', { class: 'dialog__panel' }, [heading, form]),
  ]);

  /** @type {string|null} */
  let currentId = null;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.textContent = '';
    try {
      await handlers.onSubmit({
        id: currentId ?? undefined,
        title: titleInput.value,
        section: sectionSelect.value,
        estimatedMinutes: Number(minutesInput.value || 0),
      });
      close();
    } catch (error) {
      errorEl.textContent = error instanceof ValidationError
        ? error.issues.map((i) => i.message).join(' · ')
        : 'No se pudo guardar la tarea.';
    }
  });

  el.addEventListener('close', () => {
    currentId = null;
    errorEl.textContent = '';
  });

  // Clic sobre el backdrop (fuera del panel) cierra el diálogo.
  el.addEventListener('pointerdown', (event) => {
    if (event.target === el) close();
  });

  /**
   * @param {import('../../domain/taskValidator.js').TaskDefinition|null} task
   * @param {string} [defaultSection]
   */
  function open(task = null, defaultSection = 'anytime') {
    currentId = task?.id ?? null;
    heading.textContent = task ? 'Editar tarea' : 'Nueva tarea';
    titleInput.value = task?.title ?? '';
    sectionSelect.value = task?.section ?? defaultSection;
    minutesInput.value = String(task?.estimatedMinutes ?? 5);
    archiveBtn.hidden = !task;
    errorEl.textContent = '';

    if (typeof el.showModal === 'function') el.showModal();
    else el.setAttribute('open', '');
    // El teclado móvil sólo aparece si el foco llega tras la animación de apertura.
    requestAnimationFrame(() => titleInput.focus());
  }

  function close() {
    if (typeof el.close === 'function' && el.open) el.close();
    else el.removeAttribute('open');
  }

  return { el, open, close, update() {}, destroy() {} };
}
