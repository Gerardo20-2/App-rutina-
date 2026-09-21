/**
 * @module ui/components/taskList
 * Contenedor de tareas agrupadas por bloque del día, con bloques plegables.
 *
 * El render es **reconciliado por clave** (`task.id`): los ítems existentes se
 * actualizan en lugar de recrearse. Recrear el DOM en cada cambio destruiría
 * el reconocedor de gestos en pleno arrastre y reiniciaría las transiciones
 * CSS a mitad de animación.
 *
 * ## Por qué se pliegan los bloques
 *
 * Una rutina completa son cuatro bloques y una docena larga de tareas: más de
 * dos pantallas de scroll en un móvil. A las ocho de la mañana, las tareas de
 * la noche son ruido. Por defecto sólo queda abierto el bloque de la hora
 * actual; el resto se despliega con un toque en su cabecera, que es un
 * objetivo táctil de ancho completo.
 */

import { h, clear } from '../dom.js';
import { createTaskItem } from './taskItem.js';
import { groupBySection } from '../../domain/selectors.js';

/**
 * @param {{
 *   onToggle: (id: string) => void,
 *   onSkip: (id: string) => void,
 *   onEdit: (id: string) => void,
 *   onCreate: () => void,
 *   onToggleSection: (section: string) => void,
 *   haptics?: import('../../platform/haptics.js').Haptics,
 * }} handlers
 */
export function createTaskList(handlers) {
  /** @type {Map<string, ReturnType<typeof createTaskItem>>} */
  const items = new Map();
  /** @type {Map<string, {section: HTMLElement, list: HTMLElement, counter: HTMLElement, toggle: HTMLElement}>} */
  const sections = new Map();

  const empty = h('div', { class: 'empty', hidden: true }, [
    h('p', { class: 'empty__icon', 'aria-hidden': 'true', text: '🌱' }),
    h('h2', { class: 'empty__title', text: 'Tu rutina está vacía' }),
    h('p', { class: 'empty__text', text: 'Añade la primera tarea y empieza a construir tu racha.' }),
    h('button', {
      class: 'btn btn--primary', type: 'button', text: 'Añadir tarea', onClick: () => handlers.onCreate(),
    }),
  ]);

  const container = h('div', { class: 'task-list' });
  const el = h('main', { class: 'content', id: 'contenido' }, [container, empty]);

  /** @param {import('../../core/store.js').AppState} state */
  function update(state) {
    const groups = groupBySection(state.tasks, state.log);
    const collapsed = new Set(state.ui.collapsedSections ?? []);
    empty.hidden = groups.length > 0;
    container.hidden = groups.length === 0;

    const seenTasks = new Set();
    const seenSections = new Set();

    groups.forEach((group, index) => {
      seenSections.add(group.section);
      const entry = sections.get(group.section) ?? createSection(group);
      const isCollapsed = collapsed.has(group.section);

      entry.counter.textContent = `${group.completed}/${group.tasks.length}`;
      entry.section.dataset.complete = String(group.completed === group.tasks.length);
      entry.section.dataset.collapsed = String(isCollapsed);
      entry.toggle.setAttribute('aria-expanded', String(!isCollapsed));
      entry.list.hidden = isCollapsed;

      // `appendChild` sobre un nodo ya presente lo mueve: así el orden de los
      // bloques se corrige sin desmontar nada.
      if (container.children[index] !== entry.section) {
        container.insertBefore(entry.section, container.children[index] ?? null);
      }

      group.tasks.forEach((task, taskIndex) => {
        seenTasks.add(task.id);
        let item = items.get(task.id);
        if (!item) {
          item = createTaskItem({
            task,
            record: task.record,
            onToggle: handlers.onToggle,
            onSkip: handlers.onSkip,
            onEdit: handlers.onEdit,
            haptics: handlers.haptics,
          });
          items.set(task.id, item);
        } else {
          item.update({ task, record: task.record });
        }
        if (entry.list.children[taskIndex] !== item.el) {
          entry.list.insertBefore(item.el, entry.list.children[taskIndex] ?? null);
        }
      });
    });

    for (const [id, item] of items) {
      if (seenTasks.has(id)) continue;
      item.destroy();
      item.el.remove();
      items.delete(id);
    }
    for (const [name, entry] of sections) {
      if (seenSections.has(name)) continue;
      entry.section.remove();
      sections.delete(name);
    }
  }

  /** @param {{section: string, label: string, icon: string, range: string}} group */
  function createSection(group) {
    const counter = h('span', { class: 'section__counter' });
    const list = h('ul', { class: 'section__list', role: 'list', id: `section-list-${group.section}` });
    const toggle = h('button', {
      class: 'section__toggle',
      type: 'button',
      'aria-expanded': 'true',
      'aria-controls': `section-list-${group.section}`,
      onClick: () => {
        handlers.haptics?.fire('TAP');
        handlers.onToggleSection(group.section);
      },
    }, [
      h('span', { class: 'section__icon', 'aria-hidden': 'true', text: group.icon }),
      h('span', { class: 'section__label' }, [
        h('span', { class: 'section__name', text: group.label }),
        h('span', { class: 'section__range', text: group.range }),
      ]),
      counter,
      h('span', { class: 'section__chevron', 'aria-hidden': 'true', text: '⌄' }),
    ]);

    const section = h('section', {
      class: 'section', dataset: { section: group.section },
      'aria-labelledby': `section-${group.section}`,
    }, [
      h('h2', { class: 'section__head', id: `section-${group.section}` }, [toggle]),
      list,
    ]);

    const entry = { section, list, counter, toggle };
    sections.set(group.section, entry);
    return entry;
  }

  return {
    el,
    update,
    destroy() {
      for (const item of items.values()) item.destroy();
      items.clear();
      sections.clear();
      clear(container);
    },
  };
}
