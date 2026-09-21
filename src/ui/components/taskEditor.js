/**
 * @module ui/components/taskEditor
 * Alta y edición de tareas, presentada como hoja deslizante inferior.
 *
 * Sustituye al diálogo centrado: con el teclado virtual desplegado, un modal
 * centrado queda partido por la mitad y sus botones acaban detrás del teclado.
 * Una hoja anclada abajo crece hacia arriba y mantiene los controles pegados
 * al borde del teclado, que es donde el pulgar ya está.
 *
 * El bloque del día se elige con un control segmentado de cuatro botones de
 * 48 px en lugar de un `<select>`: un desplegable nativo abre una rueda a
 * pantalla completa para elegir entre cuatro opciones que caben en una línea.
 */

import { h } from '../dom.js';
import { createBottomSheet } from './bottomSheet.js';
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
    enterkeyhint: 'done', placeholder: 'Meditación 10 min',
  });

  const sectionPicker = createSectionPicker();

  const minutesInput = h('input', {
    class: 'field__input', id: 'task-minutes', name: 'estimatedMinutes', type: 'number',
    min: '0', max: String(LIMITS.TASK_MINUTES_MAX), step: '1', inputmode: 'numeric', value: '5',
  });

  const errorEl = h('p', { class: 'field__error', role: 'alert' });

  const archiveBtn = h('button', {
    class: 'btn btn--danger btn--block', type: 'button', hidden: true, text: 'Archivar tarea',
    onClick: async () => {
      if (!currentId) return;
      await handlers.onArchive(currentId);
      sheet.close();
    },
  });

  const submitBtn = h('button', { class: 'btn btn--primary btn--block', type: 'submit', text: 'Guardar' });

  const form = h('form', { class: 'sheet__form', novalidate: true }, [
    h('div', { class: 'field' }, [
      h('label', { class: 'field__label', for: 'task-title', text: 'Título' }),
      titleInput,
    ]),
    h('div', { class: 'field' }, [
      h('span', { class: 'field__label', id: 'task-section-label', text: 'Bloque del día' }),
      sectionPicker.el,
    ]),
    h('div', { class: 'field' }, [
      h('label', { class: 'field__label', for: 'task-minutes', text: 'Minutos estimados' }),
      minutesInput,
    ]),
    errorEl,
    // Acciones al final y a ancho completo: quedan sobre el teclado virtual y
    // se alcanzan sin recolocar la mano.
    h('div', { class: 'sheet__actions' }, [submitBtn, archiveBtn]),
  ]);

  const sheet = createBottomSheet({ id: 'sheet-editor', title: 'Nueva tarea' });
  sheet.setContent(form);

  /** @type {string|null} */
  let currentId = null;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.textContent = '';
    submitBtn.disabled = true;
    try {
      await handlers.onSubmit({
        id: currentId ?? undefined,
        title: titleInput.value,
        section: sectionPicker.value,
        estimatedMinutes: Number(minutesInput.value || 0),
      });
      sheet.close();
    } catch (error) {
      errorEl.textContent = error instanceof ValidationError
        ? error.issues.map((issue) => issue.message).join(' · ')
        : 'No se pudo guardar la tarea.';
    } finally {
      submitBtn.disabled = false;
    }
  });

  /**
   * @param {import('../../domain/taskValidator.js').TaskDefinition|null} task
   * @param {string} [defaultSection]
   * @param {HTMLElement} [trigger] elemento que recupera el foco al cerrar.
   */
  function open(task = null, defaultSection = 'anytime', trigger) {
    currentId = task?.id ?? null;
    sheet.setTitle(task ? 'Editar tarea' : 'Nueva tarea');
    titleInput.value = task?.title ?? '';
    sectionPicker.set(task?.section ?? defaultSection);
    minutesInput.value = String(task?.estimatedMinutes ?? 5);
    archiveBtn.hidden = !task;
    errorEl.textContent = '';
    sheet.open(trigger);
    // El teclado móvil sólo aparece si el foco llega tras la animación de apertura.
    requestAnimationFrame(() => titleInput.focus());
  }

  return {
    el: sheet.el,
    open,
    close: () => sheet.close(),
    get isOpen() {
      return sheet.isOpen;
    },
    update() {},
    destroy() {
      sheet.destroy();
    },
  };
}

/** Control segmentado de bloques del día, accesible como grupo de radios. */
function createSectionPicker() {
  /** @type {Map<string, HTMLInputElement>} */
  const inputs = new Map();

  const el = h('div', { class: 'segmented', role: 'radiogroup', 'aria-labelledby': 'task-section-label' },
    SECTION_ORDER.map((section) => {
      const input = h('input', {
        class: 'segmented__input', type: 'radio', name: 'section', id: `section-${section}`, value: section,
      });
      inputs.set(section, input);
      return h('label', {
        class: 'segmented__option', for: `section-${section}`,
        title: SECTION_META[section].label,
      }, [
        input,
        h('span', { class: 'segmented__icon', 'aria-hidden': 'true', text: SECTION_META[section].icon }),
        h('span', { class: 'segmented__text', text: SECTION_META[section].short }),
      ]);
    }));

  return {
    el,
    get value() {
      for (const [section, input] of inputs) if (input.checked) return section;
      return SECTION_ORDER[SECTION_ORDER.length - 1];
    },
    /** @param {string} section */
    set(section) {
      const target = inputs.get(section) ?? inputs.get(SECTION_ORDER[SECTION_ORDER.length - 1]);
      if (target) target.checked = true;
    },
  };
}
