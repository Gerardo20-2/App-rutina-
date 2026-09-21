/**
 * @module ui/components/taskList
 * Agenda del día: bloques horarios plegables con sus tareas.
 *
 * Los bloques que se renderizan son los que **existen hoy** según el día de la
 * semana y tienen al menos una tarea aplicable; el resto no llega al DOM. El
 * bloque en curso se destaca y se despliega solo.
 *
 * El render es **reconciliado por clave** (`task.id`, `block.id`): los ítems
 * existentes se actualizan en lugar de recrearse. Recrear el DOM en cada
 * cambio destruiría el reconocedor de gestos en pleno arrastre y reiniciaría
 * las transiciones CSS a mitad de animación.
 */

import { h, clear } from '../dom.js';
import { createTaskItem } from './taskItem.js';
import { groupByBlock } from '../../domain/selectors.js';

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
  /** @type {Map<string, Object>} */
  const sections = new Map();

  const empty = h('div', { class: 'empty', hidden: true }, [
    h('p', { class: 'empty__icon', 'aria-hidden': 'true', text: '🌱' }),
    h('h2', { class: 'empty__title', text: 'Hoy no hay nada programado' }),
    h('p', {
      class: 'empty__text',
      text: 'Ninguna tarea aplica a este día de la semana. Añade una o revisa sus días activos.',
    }),
    h('button', {
      class: 'btn btn--primary', type: 'button', text: 'Añadir tarea', onClick: () => handlers.onCreate(),
    }),
  ]);

  const container = h('div', { class: 'task-list' });
  const el = h('main', { class: 'content', id: 'contenido' }, [container, empty]);

  /** @param {import('../../core/store.js').AppState} state */
  function update(state) {
    const groups = groupByBlock(state.tasks, state.log, {
      date: state.today,
      schedule: state.schedule,
      activeBlockId: state.ui.activeBlockId,
    });
    const collapsed = new Set(state.ui.collapsedSections ?? []);
    empty.hidden = groups.length > 0;
    container.hidden = groups.length === 0;

    const seenTasks = new Set();
    const seenSections = new Set();

    groups.forEach((group, index) => {
      seenSections.add(group.id);
      const entry = sections.get(group.id) ?? createSection(group);
      const isCollapsed = collapsed.has(group.id);

      entry.counter.textContent = `${group.completed}/${group.tasks.length}`;
      entry.range.textContent = group.range;
      entry.badge.hidden = !group.isActive;
      entry.section.dataset.complete = String(group.completed === group.tasks.length);
      entry.section.dataset.collapsed = String(isCollapsed);
      entry.section.dataset.active = String(group.isActive);
      entry.section.dataset.anchor = String(group.isAnchor);
      entry.toggle.setAttribute('aria-expanded', String(!isCollapsed));
      entry.list.hidden = isCollapsed;

      // `insertBefore` sobre un nodo ya presente lo mueve: así el orden de los
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

    // Las tareas que hoy no aplican se desmontan: no basta con ocultarlas, no
    // deben existir en el DOM ni conservar reconocedores de gestos vivos.
    for (const [id, item] of items) {
      if (seenTasks.has(id)) continue;
      item.destroy();
      item.el.remove();
      items.delete(id);
    }
    for (const [id, entry] of sections) {
      if (seenSections.has(id)) continue;
      entry.section.remove();
      sections.delete(id);
    }
  }

  /** @param {Object} group */
  function createSection(group) {
    const counter = h('span', { class: 'section__counter' });
    const range = h('span', { class: 'section__range', text: group.range });
    const badge = h('span', { class: 'section__badge', hidden: true }, [
      h('span', { class: 'section__pulse', 'aria-hidden': 'true' }),
      'Bloque en curso',
    ]);
    const list = h('ul', { class: 'section__list', role: 'list', id: `section-list-${group.id}` });

    const toggle = h('button', {
      class: 'section__toggle',
      type: 'button',
      'aria-expanded': 'true',
      'aria-controls': `section-list-${group.id}`,
      onClick: () => {
        handlers.haptics?.fire('TAP');
        handlers.onToggleSection(group.id);
      },
    }, [
      h('span', { class: 'section__icon', 'aria-hidden': 'true', text: group.icon }),
      h('span', { class: 'section__label' }, [
        h('span', { class: 'section__name' }, [
          group.label,
          group.isAnchor ? h('span', { class: 'section__anchor', title: 'Bloque rígido', text: '📌' }) : null,
        ]),
        h('span', { class: 'section__meta' }, [range, badge]),
      ]),
      counter,
      h('span', { class: 'section__chevron', 'aria-hidden': 'true', text: '⌄' }),
    ]);

    const section = h('section', {
      class: 'section', dataset: { section: group.id },
      'aria-labelledby': `section-${group.id}`,
    }, [
      h('h2', { class: 'section__head', id: `section-${group.id}` }, [toggle]),
      list,
    ]);

    const entry = { section, list, counter, toggle, badge, range };
    sections.set(group.id, entry);
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
