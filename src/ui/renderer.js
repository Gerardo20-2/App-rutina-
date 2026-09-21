/**
 * @module ui/renderer
 * Montaje dinámico en el DOM y única suscripción al store.
 *
 * El renderer no contiene lógica de negocio: traduce comandos de UI a llamadas
 * del {@link RoutineService} y reparte el estado a los componentes. Cada
 * componente decide qué parte redibuja, y el reparto se hace en un
 * `requestAnimationFrame` para agrupar mutaciones dentro de un mismo frame.
 */

import { h } from './dom.js';
import { createHeader } from './components/header.js';
import { createTaskList } from './components/taskList.js';
import { createHeatmap } from './components/heatmap.js';
import { createTaskEditor } from './components/taskEditor.js';
import { createSettingsPanel } from './components/settingsPanel.js';
import { createToaster } from './components/toast.js';
import { EVENTS } from '../core/constants.js';
import { currentSection } from '../core/dateUtils.js';

/**
 * @param {{
 *   root: HTMLElement,
 *   store: import('../core/store.js').Store,
 *   bus: import('../core/events.js').EventBus,
 *   service: import('../domain/routineService.js').RoutineService,
 *   haptics: import('../platform/haptics.js').Haptics,
 *   wakeLock: import('../platform/wakeLock.js').WakeLockController,
 * }} deps
 */
export function createRenderer({ root, store, bus, service, haptics, wakeLock }) {
  const toaster = createToaster(bus);

  const editor = createTaskEditor({
    onSubmit: async (values) => {
      await service.saveTask(values);
      bus.emit(EVENTS.TOAST, { message: values.id ? 'Tarea actualizada' : 'Tarea añadida', tone: 'success' });
    },
    onArchive: async (id) => {
      await service.archiveTask(id);
      bus.emit(EVENTS.TOAST, { message: 'Tarea archivada', tone: 'info' });
    },
  });

  const header = createHeader();

  const taskList = createTaskList({
    haptics,
    onToggle: (id) => void run(() => service.toggleTask(id)),
    onSkip: (id) => void run(() => service.skipTask(id)),
    onEdit: (id) => {
      const task = store.getState().tasks.find((t) => t.id === id);
      if (task) editor.open(task);
    },
    onCreate: () => editor.open(null, currentSection()),
  });

  const heatmap = createHeatmap();

  const settings = createSettingsPanel({
    capabilities: { haptics: haptics.supported, wakeLock: wakeLock.supported },
    onPreferenceChange: (patch) => void run(async () => {
      const preferences = await service.setPreferences(patch);
      applyPreferences(preferences);
    }),
    onExport: () => void run(exportBackup),
    onImport: (file) => void run(() => importBackup(file)),
    onWipe: () => {
      if (!confirm('Se borrarán todas las tareas y el historial. Esta acción no se puede deshacer.')) return;
      void run(async () => {
        await service.wipe();
        bus.emit(EVENTS.TOAST, { message: 'Datos borrados', tone: 'info' });
      });
    },
  });

  const fab = h('button', {
    class: 'fab', type: 'button', 'aria-label': 'Añadir tarea',
    onClick: () => {
      haptics.fire('TAP');
      editor.open(null, currentSection());
    },
  }, [h('span', { 'aria-hidden': 'true', text: '+' })]);

  const app = h('div', { class: 'app' }, [
    header.el,
    taskList.el,
    h('div', { class: 'app__panels' }, [heatmap.el, settings.el]),
    h('footer', { class: 'app__footer' }, [
      h('p', { text: 'Tus datos nunca salen de este dispositivo.' }),
    ]),
  ]);

  const components = [header, taskList, heatmap, settings];
  let frame = null;

  function mount() {
    root.replaceChildren(app, fab, editor.el, toaster.el);
    applyPreferences(store.getState().preferences);
    render(store.getState());

    // Atajo del manifest (`?action=new-task`): abre el editor al lanzar la PWA
    // desde el menú contextual del icono, y limpia la URL para que un
    // refresco no lo reabra.
    if (new URLSearchParams(location.search).get('action') === 'new-task') {
      editor.open(null, currentSection());
      history.replaceState(null, '', location.pathname);
    }

    // Una sola suscripción: la identidad del estado cambia con cada mutación,
    // así que el selector identidad basta y evita N suscripciones activas.
    const unsubscribe = store.subscribe((state) => state, scheduleRender);

    const offDayRolled = bus.on(EVENTS.DAY_ROLLED, ({ evaluations }) => {
      const broken = evaluations.find((e) => e.transition === 'BROKEN');
      const shielded = evaluations.find((e) => e.shieldConsumed);
      if (shielded) {
        bus.emit(EVENTS.TOAST, { message: '🛡️ Un escudo salvó tu racha', tone: 'info', timeout: 5000 });
      } else if (broken) {
        bus.emit(EVENTS.TOAST, { message: 'La racha se reinició. Hoy empieza otra.', tone: 'info', timeout: 5000 });
      } else {
        bus.emit(EVENTS.TOAST, { message: 'Nuevo día, rutina reiniciada', tone: 'success' });
      }
    });

    const offToggled = bus.on(EVENTS.TASK_TOGGLED, ({ completed, log }) => {
      if (!completed) return;
      const done = log.completedCount;
      const total = Math.max(0, log.totalActiveTasks - Object.values(log.entries).filter((e) => e.skipped).length);
      if (total > 0 && done === total) {
        haptics.fire('STREAK_UP');
        bus.emit(EVENTS.TOAST, { message: '🎉 Rutina completa. ¡Bien hecho!', tone: 'success' });
      }
    });

    const offError = bus.on(EVENTS.ERROR, ({ error }) => {
      bus.emit(EVENTS.TOAST, { message: error?.message ?? 'Algo ha fallado', tone: 'error' });
    });

    return () => {
      unsubscribe();
      offDayRolled();
      offToggled();
      offError();
      if (frame !== null) cancelAnimationFrame(frame);
      for (const component of components) component.destroy();
      toaster.destroy();
      editor.destroy();
    };
  }

  function scheduleRender(state) {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      render(store.getState() ?? state);
    });
  }

  /** @param {import('../core/store.js').AppState} state */
  function render(state) {
    document.documentElement.dataset.ready = String(state.ready);
    for (const component of components) component.update(state);
  }

  /** @param {Object} preferences */
  function applyPreferences(preferences) {
    haptics.setEnabled(preferences.hapticsEnabled);
    void wakeLock.toggle(Boolean(preferences.wakeLockEnabled));
    const root = document.documentElement;
    if (preferences.theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = preferences.theme;
  }

  async function exportBackup() {
    const dump = await service.exportBackup();
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: `routine-tracker-${store.getState().today}.json` });
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revocar de inmediato cancela la descarga en algunos navegadores.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    bus.emit(EVENTS.TOAST, { message: 'Copia de seguridad descargada', tone: 'success' });
  }

  /** @param {File} file */
  async function importBackup(file) {
    const text = await file.text();
    const result = await service.importBackup(text);
    bus.emit(EVENTS.TOAST, {
      message: `Importado: ${result.tasks} tareas y ${result.logs} días`,
      tone: 'success',
    });
  }

  /**
   * Envoltura común de comandos asíncronos: un fallo de persistencia se
   * reporta al usuario en vez de quedar en un `unhandledrejection`.
   * @param {() => Promise<*>} work
   */
  async function run(work) {
    try {
      return await work();
    } catch (error) {
      console.error('[Renderer] comando fallido', error);
      haptics.fire('ERROR');
      bus.emit(EVENTS.TOAST, { message: error?.message ?? 'Acción no completada', tone: 'error' });
      return null;
    }
  }

  return { mount, render, applyPreferences };
}
