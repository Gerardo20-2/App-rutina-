/**
 * @module ui/renderer
 * Montaje dinámico en el DOM y única suscripción al store.
 *
 * El renderer no contiene lógica de negocio: traduce comandos de UI a llamadas
 * del {@link RoutineService} y reparte el estado a los componentes. Cada
 * componente decide qué parte redibuja, y el reparto se hace en un
 * `requestAnimationFrame` para agrupar mutaciones dentro de un mismo frame.
 *
 * ## Reparto de la pantalla (zona del pulgar)
 *
 *   arriba   `header`     lectura pasiva: fecha, racha, anillo de progreso
 *   centro   `taskList`   la rutina, con bloques plegables
 *   abajo    `bottomBar`  todas las acciones: añadir, histórico, ajustes
 *   overlay  hojas        editor, histórico y ajustes, siempre desde abajo
 */

import { h } from './dom.js';
import { createHeader } from './components/header.js';
import { createTaskList } from './components/taskList.js';
import { createHeatmap } from './components/heatmap.js';
import { createTaskEditor } from './components/taskEditor.js';
import { createSettingsPanel } from './components/settingsPanel.js';
import { createBottomSheet } from './components/bottomSheet.js';
import { createBottomBar } from './components/bottomBar.js';
import { createToaster } from './components/toast.js';
import { EVENTS, STREAK_TRANSITION } from '../core/constants.js';
import { TimeBlockWatcher, FALLBACK_BLOCK_ID } from '../domain/timeBlockService.js';

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
      const task = store.getState().tasks.find((candidate) => candidate.id === id);
      if (task) editor.open(task, task.sectionId);
    },
    onCreate: () => editor.open(null, defaultBlock()),
    onToggleSection: (section) => service.toggleSection(section),
  });

  const heatmap = createHeatmap();
  const historySheet = createBottomSheet({ id: 'sheet-history', title: 'Histórico' });
  historySheet.setContent(heatmap.el);

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
        settingsSheet.close();
        bus.emit(EVENTS.TOAST, { message: 'Datos borrados', tone: 'info' });
      });
    },
  });
  const settingsSheet = createBottomSheet({ id: 'sheet-settings', title: 'Ajustes' });
  settingsSheet.setContent(settings.el);

  const bottomBar = createBottomBar({
    haptics,
    onCreate: (trigger) => editor.open(null, defaultBlock(), trigger),
    onHistory: (trigger) => {
      historySheet.open(trigger);
      // El canvas se dimensiona contra su contenedor: dentro de una hoja aún
      // sin pintar mediría 0, así que se redibuja una vez abierta.
      requestAnimationFrame(() => heatmap.redraw());
    },
    onSettings: (trigger) => settingsSheet.open(trigger),
  });

  const app = h('div', { class: 'app' }, [
    header.el,
    taskList.el,
    h('footer', { class: 'app__footer' }, [
      h('p', { text: 'Tus datos nunca salen de este dispositivo.' }),
    ]),
  ]);

  const components = [header, taskList, heatmap, settings, bottomBar];
  let frame = null;

  /**
   * Vigila el paso de un bloque horario al siguiente y refresca la agenda sin
   * recargar la página: al dar las 19:00 de un martes, «Clase» pasa a estar en
   * curso y se despliega sola.
   */
  let firstBlockResolution = true;
  const blockWatcher = new TimeBlockWatcher({
    onChange: ({ blockId }) => {
      service.refreshTimeContext();
      // La primera resolución no es una transición: es el estado con el que
      // arranca la aplicación, y vibrar al abrirla sería ruido.
      if (!firstBlockResolution && blockId !== null) haptics.fire('TAP');
      firstBlockResolution = false;
    },
  });

  /** Bloque sugerido al crear una tarea: el que está en curso. */
  function defaultBlock() {
    return store.getState().ui.activeBlockId ?? FALLBACK_BLOCK_ID;
  }

  function mount() {
    root.replaceChildren(app, bottomBar.el, editor.el, historySheet.el, settingsSheet.el, toaster.el);
    applyPreferences(store.getState().preferences);
    render(store.getState());

    // Atajo del manifest (`?action=new-task`): abre el editor al lanzar la PWA
    // desde el menú contextual del icono, y limpia la URL para que un
    // refresco no lo reabra.
    if (new URLSearchParams(location.search).get('action') === 'new-task') {
      editor.open(null, defaultBlock());
      history.replaceState(null, '', location.pathname);
    }

    blockWatcher.start();

    // Una sola suscripción: la identidad del estado cambia con cada mutación,
    // así que el selector identidad basta y evita N suscripciones activas.
    const unsubscribe = store.subscribe((state) => state, scheduleRender);

    const offDayRolled = bus.on(EVENTS.DAY_ROLLED, ({ evaluations }) => {
      const broken = evaluations.find((item) => item.transition === STREAK_TRANSITION.BROKEN);
      const shielded = evaluations.find((item) => item.shieldConsumed);
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
      const skipped = Object.values(log.entries).filter((entry) => entry.skipped).length;
      const computable = Math.max(0, log.totalActiveTasks - skipped);
      if (computable > 0 && log.completedCount === computable) {
        haptics.fire('STREAK_UP');
        bus.emit(EVENTS.TOAST, { message: '🎉 Rutina completa. ¡Bien hecho!', tone: 'success' });
      }
    });

    const offClock = bus.on(EVENTS.CLOCK_DESYNC, ({ frozen }) => {
      if (!frozen) return;
      bus.emit(EVENTS.TOAST, {
        message: 'Reloj desincronizado: el cierre del día está en pausa',
        tone: 'error',
        timeout: 8000,
      });
    });

    const offError = bus.on(EVENTS.ERROR, ({ error }) => {
      bus.emit(EVENTS.TOAST, { message: error?.message ?? 'Algo ha fallado', tone: 'error' });
    });

    return () => {
      blockWatcher.stop();
      unsubscribe();
      offDayRolled();
      offToggled();
      offClock();
      offError();
      if (frame !== null) cancelAnimationFrame(frame);
      for (const component of components) component.destroy();
      editor.destroy();
      historySheet.destroy();
      settingsSheet.destroy();
      toaster.destroy();
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
    const documentRoot = document.documentElement;
    if (preferences.theme === 'system') delete documentRoot.dataset.theme;
    else documentRoot.dataset.theme = preferences.theme;
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
    settingsSheet.close();
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
