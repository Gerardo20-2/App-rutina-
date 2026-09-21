/**
 * @module ui/components/taskEditor
 * Alta y edición de tareas, presentada como hoja deslizante inferior.
 *
 * Sustituye al diálogo centrado: con el teclado virtual desplegado, un modal
 * centrado queda partido por la mitad y sus botones acaban detrás del teclado.
 * Una hoja anclada abajo crece hacia arriba y mantiene los controles pegados
 * al borde del teclado, que es donde el pulgar ya está.
 *
 * El formulario refleja el modelo de agenda: bloque horario, días de la semana
 * en los que aplica, horas de referencia y si es un bloque rígido.
 */

import { h } from '../dom.js';
import { createBottomSheet } from './bottomSheet.js';
import { LIMITS } from '../../core/constants.js';
import { ValidationError } from '../../domain/taskValidator.js';
import {
  BLOCK_CATALOG, DAY_LABELS, DAY_NAMES, FALLBACK_BLOCK_ID, describeDays,
} from '../../domain/timeBlockService.js';

/**
 * @param {{
 *   onSubmit: (values: Object) => Promise<void>,
 *   onArchive: (id: string) => Promise<void>,
 * }} handlers
 */
export function createTaskEditor(handlers) {
  const titleInput = h('input', {
    class: 'field__input', id: 'task-title', name: 'title', type: 'text',
    required: true, maxlength: String(LIMITS.TASK_TITLE_MAX), autocomplete: 'off',
    enterkeyhint: 'done', placeholder: 'Clase universitaria',
  });

  const blockSelect = h('select', { class: 'field__input', id: 'task-block' }, buildBlockOptions());
  const blockHint = h('p', { class: 'field__hint' });

  const dayPicker = createDayPicker();

  const startInput = h('input', {
    class: 'field__input', id: 'task-start', type: 'time', step: '300', name: 'timeStart',
  });
  const endInput = h('input', {
    class: 'field__input', id: 'task-end', type: 'time', step: '300', name: 'timeEnd',
  });

  const anchorInput = h('input', { class: 'switch__input', id: 'task-anchor', type: 'checkbox' });
  const anchorToggle = h('div', { class: 'switch' }, [
    h('label', { class: 'switch__label', for: 'task-anchor' }, [
      h('span', { class: 'switch__text' }, [
        h('span', { class: 'switch__title', text: 'Bloque rígido' }),
        h('span', { class: 'switch__hint', text: 'Trabajo, clase o traslado: no se negocia' }),
      ]),
      anchorInput,
      h('span', { class: 'switch__track', 'aria-hidden': 'true' }),
    ]),
  ]);

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
      h('label', { class: 'field__label', for: 'task-block', text: 'Bloque horario' }),
      blockSelect,
      blockHint,
    ]),
    h('div', { class: 'field' }, [
      h('span', { class: 'field__label', id: 'task-days-label', text: 'Días activos' }),
      dayPicker.el,
      h('p', { class: 'field__hint', text: 'Sin ninguno marcado, la tarea aplica todos los días del bloque.' }),
    ]),
    h('div', { class: 'field-row' }, [
      h('div', { class: 'field' }, [
        h('label', { class: 'field__label', for: 'task-start', text: 'Desde' }),
        startInput,
      ]),
      h('div', { class: 'field' }, [
        h('label', { class: 'field__label', for: 'task-end', text: 'Hasta' }),
        endInput,
      ]),
    ]),
    anchorToggle,
    errorEl,
    // Acciones al final y a ancho completo: quedan sobre el teclado virtual y
    // se alcanzan sin recolocar la mano.
    h('div', { class: 'sheet__actions' }, [submitBtn, archiveBtn]),
  ]);

  const sheet = createBottomSheet({ id: 'sheet-editor', title: 'Nueva tarea' });
  sheet.setContent(form);

  /** @type {string|null} */
  let currentId = null;

  // Al cambiar de bloque, los días que ese bloque no cubre dejan de estar
  // disponibles: una tarea en «Turno DiDi» marcada en jueves nunca se vería.
  blockSelect.addEventListener('change', () => syncBlockConstraints());

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.textContent = '';
    submitBtn.disabled = true;
    try {
      await handlers.onSubmit({
        id: currentId ?? undefined,
        title: titleInput.value,
        sectionId: blockSelect.value,
        daysOfWeek: dayPicker.value,
        timeStart: startInput.value || undefined,
        timeEnd: endInput.value || undefined,
        isAnchor: anchorInput.checked,
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

  /** Ajusta días disponibles y textos de ayuda al bloque seleccionado. */
  function syncBlockConstraints() {
    const block = BLOCK_CATALOG[blockSelect.value] ?? BLOCK_CATALOG[FALLBACK_BLOCK_ID];
    const allowed = new Set(block.rules.flatMap((rule) => rule.days));
    dayPicker.restrictTo(allowed);

    const ranges = block.rules
      .map((rule) => (rule.start ? `${describeDays(rule.days)}: ${rule.start} – ${rule.end}` : describeDays(rule.days)))
      .join(' · ');
    blockHint.textContent = block.rules.some((rule) => rule.start)
      ? ranges
      : `${ranges} · sin horario fijo`;
    if (anchorInput.dataset.touched !== '1') anchorInput.checked = block.isAnchor;
  }

  /**
   * @param {import('../../domain/taskValidator.js').TaskDefinition|null} task
   * @param {string} [defaultBlock]
   * @param {HTMLElement} [trigger] elemento que recupera el foco al cerrar.
   */
  function open(task = null, defaultBlock = FALLBACK_BLOCK_ID, trigger) {
    currentId = task?.id ?? null;
    sheet.setTitle(task ? 'Editar tarea' : 'Nueva tarea');
    titleInput.value = task?.title ?? '';
    blockSelect.value = BLOCK_CATALOG[task?.sectionId ?? defaultBlock] ? (task?.sectionId ?? defaultBlock) : FALLBACK_BLOCK_ID;
    startInput.value = task?.timeStart ?? '';
    endInput.value = task?.timeEnd ?? '';
    anchorInput.checked = Boolean(task?.isAnchor);
    anchorInput.dataset.touched = task ? '1' : '0';
    dayPicker.set(task?.daysOfWeek ?? []);
    syncBlockConstraints();
    archiveBtn.hidden = !task;
    errorEl.textContent = '';
    sheet.open(trigger);
    // El teclado móvil sólo aparece si el foco llega tras la animación de apertura.
    requestAnimationFrame(() => titleInput.focus());
  }

  anchorInput.addEventListener('change', () => { anchorInput.dataset.touched = '1'; });

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

/** Opciones del selector de bloque, agrupadas por los días en que existen. */
function buildBlockOptions() {
  /** @type {Map<string, HTMLOptionElement[]>} */
  const groups = new Map();
  for (const block of Object.values(BLOCK_CATALOG)) {
    const days = [...new Set(block.rules.flatMap((rule) => rule.days))].sort();
    const groupLabel = describeDays(days);
    const option = h('option', { value: block.id, text: `${block.icon}  ${block.label}` });
    if (!groups.has(groupLabel)) groups.set(groupLabel, []);
    groups.get(groupLabel).push(option);
  }
  return [...groups.entries()].map(([label, options]) => h('optgroup', { label }, options));
}

/** Selector de días de la semana con casillas de 48 px. */
function createDayPicker() {
  /** @type {Map<number, HTMLInputElement>} */
  const inputs = new Map();

  // Se muestran de lunes a domingo, que es como se lee una semana, aunque el
  // valor almacenado use la numeración de `getDay()` (0 = domingo).
  const order = [1, 2, 3, 4, 5, 6, 0];

  const el = h('div', { class: 'daypicker', role: 'group', 'aria-labelledby': 'task-days-label' },
    order.map((day) => {
      const input = h('input', {
        class: 'daypicker__input', type: 'checkbox', id: `day-${day}`, value: String(day),
      });
      inputs.set(day, input);
      return h('label', {
        class: 'daypicker__option', for: `day-${day}`, title: DAY_NAMES[day],
      }, [input, h('span', { class: 'daypicker__text', text: DAY_LABELS[day] })]);
    }));

  return {
    el,
    /** @returns {number[]} días marcados; vacío = todos. */
    get value() {
      const days = [...inputs.entries()].filter(([, input]) => input.checked).map(([day]) => day);
      return days.length === 7 ? [] : days.sort((a, b) => a - b);
    },
    /** @param {number[]} days */
    set(days) {
      const selected = new Set(days ?? []);
      for (const [day, input] of inputs) input.checked = selected.has(day);
    },
    /**
     * Deshabilita los días que el bloque no cubre y desmarca los que queden
     * fuera: dejarlos marcados crearía una tarea que nunca se muestra.
     * @param {Set<number>} allowed
     */
    restrictTo(allowed) {
      for (const [day, input] of inputs) {
        const usable = allowed.has(day);
        input.disabled = !usable;
        input.closest('.daypicker__option')?.classList.toggle('is-disabled', !usable);
        if (!usable) input.checked = false;
      }
    },
  };
}
