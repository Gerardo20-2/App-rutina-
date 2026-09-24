/**
 * @module domain/routineService
 * Servicio de aplicación: único punto donde se originan mutaciones del estado
 * persistido. La UI despacha comandos (`toggleTask`, `skipTask`, …) y el
 * servicio se encarga de validar, persistir, actualizar el store y emitir los
 * eventos de dominio. Ningún componente escribe en el repositorio.
 *
 * Orden de operaciones de todo comando: **persistir → actualizar store →
 * emitir evento**, salvo en las marcas de tarea, que se pintan de forma
 * optimista y se revierten si la escritura falla (ver `_writeEntry`).
 */

import { EVENTS, LIMITS } from '../core/constants.js';
import { toDateKey } from '../core/dateUtils.js';
import { createExecutionRecord, validateDailyLog, ValidationError } from './taskValidator.js';
import { buildHistory } from './selectors.js';
import { projectToday } from './streakCalculator.js';
import {
  resolveSchedule, activeBlockId, countTasksForDay, tasksForDay, isTaskActiveOn,
  FALLBACK_BLOCK_ID,
} from './timeBlockService.js';
import { INITIAL_TASKS } from '../storage/seedData.js';

export { INITIAL_TASKS as SEED_TASKS };

export class RoutineService {
  /**
   * @param {{
   *   repository: import('../storage/repository.js').Repository,
   *   store: import('../core/store.js').Store,
   *   bus: import('../core/events.js').EventBus,
   *   now?: () => Date,
   * }} deps
   */
  constructor({ repository, store, bus, now = () => new Date() }) {
    this._repository = repository;
    this._store = store;
    this._bus = bus;
    this._now = now;
  }

  /**
   * Carga el estado persistido en el store. Siembra la rutina real en el
   * primer arranque.
   * @returns {Promise<void>}
   */
  async hydrate() {
    const now = this._now();
    const today = toDateKey(now);
    let tasks = await this._repository.listTasks();

    if (tasks.length === 0 && (await this._isFirstRun())) {
      await this.seedDefaults();
      tasks = await this._repository.listTasks();
    }

    const schedule = resolveSchedule(now);
    const blockId = activeBlockId(now, schedule);
    // El divisor del día son **sólo** las tareas aplicables hoy: un lunes sin
    // clase no puede penalizar por no haber ido a clase.
    const applicable = countTasksForDay(tasks, today);

    const [log, streak, preferences, logs] = await Promise.all([
      this._repository.ensureLog(today, applicable),
      this._repository.getStreak(),
      this._repository.getPreferences(),
      this._repository.recentLogs(LIMITS.HEATMAP_WEEKS * 7, today),
    ]);

    this._store.setState({
      ready: true,
      today,
      tasks,
      schedule,
      log,
      streak,
      preferences,
      history: buildHistory(logs),
      ui: {
        ...this._store.getState().ui,
        persistence: this._repository.engine,
        activeBlockId: blockId,
        collapsedSections: defaultCollapsedSections(tasks, now),
      },
    });
    this._bus.emit(EVENTS.READY, { engine: this._repository.engine, tasks: tasks.length, blockId });
  }

  /** Inserta la rutina real precargada. @returns {Promise<void>} */
  async seedDefaults() {
    for (const seed of INITIAL_TASKS) {
      await this._repository.saveTask(seed);
    }
    await this._repository.setMeta('seeded_at', new Date().toISOString());
  }

  /**
   * Recalcula la agenda y el bloque en curso. Lo llama el vigilante horario
   * cuando cambia el bloque activo, sin recargar la página.
   * @param {Date} [now]
   * @returns {string|null} bloque activo.
   */
  refreshTimeContext(now = this._now()) {
    const schedule = resolveSchedule(now);
    const blockId = activeBlockId(now, schedule);
    const { ui } = this._store.getState();

    this._store.setState({
      schedule,
      ui: {
        ...ui,
        activeBlockId: blockId,
        // Auto-enfoque: el bloque que entra en curso se despliega solo. Los
        // demás conservan el estado en que los dejó el usuario.
        collapsedSections: blockId === null
          ? ui.collapsedSections
          : ui.collapsedSections.filter((section) => section !== blockId),
      },
    });
    return blockId;
  }

  /**
   * Marca/desmarca una tarea en el día activo.
   * @param {string} taskId
   * @param {boolean} [force] valor explícito; si se omite, alterna.
   * @returns {Promise<import('./taskValidator.js').DailyLog>}
   */
  async toggleTask(taskId, force) {
    const state = this._store.getState();
    const task = this._requireActiveTask(taskId, state);
    const previous = state.log.entries[taskId] ?? createExecutionRecord();
    const completed = force ?? !previous.completed;
    const streakBefore = projectToday(state.streak, state.log).projectedStreak;

    const log = await this._writeEntry(state.log, taskId, {
      completed,
      completedAt: completed ? new Date().toISOString() : null,
      skipped: false,
    });

    this._bus.emit(EVENTS.TASK_TOGGLED, {
      taskId,
      task,
      completed,
      log,
      streakIncreased: projectToday(this._store.getState().streak, log).projectedStreak > streakBefore,
    });
    return log;
  }

  /**
   * Dispensa una tarea del día (swipe-left): sale del denominador, por lo que
   * no penaliza el ratio de cumplimiento.
   * @param {string} taskId
   * @param {boolean} [force]
   */
  async skipTask(taskId, force) {
    const state = this._store.getState();
    this._requireActiveTask(taskId, state);
    const previous = state.log.entries[taskId] ?? createExecutionRecord();
    const skipped = force ?? !previous.skipped;
    const log = await this._writeEntry(state.log, taskId, { completed: false, completedAt: null, skipped });
    this._bus.emit(EVENTS.TASK_SKIPPED, { taskId, skipped, log });
    return log;
  }

  /**
   * Crea o actualiza una tarea y re-sincroniza el total del día.
   * @param {Partial<import('./taskValidator.js').TaskDefinition>} input
   */
  async saveTask(input) {
    const draft = { ...input };
    if (!draft.id && !draft.sectionId) {
      draft.sectionId = this._store.getState().ui.activeBlockId ?? FALLBACK_BLOCK_ID;
    }
    const task = await this._repository.saveTask(draft);
    await this._refreshTasks();
    this._expandSection(task.sectionId);
    this._bus.emit(EVENTS.TASK_SAVED, { task, isNew: !input.id });
    return task;
  }

  /** @param {string} taskId */
  async archiveTask(taskId) {
    await this._repository.archiveTask(taskId);
    await this._refreshTasks();
    this._bus.emit(EVENTS.TASK_ARCHIVED, { taskId });
  }

  /** @param {string[]} orderedIds */
  async reorderTasks(orderedIds) {
    await this._repository.reorderTasks(orderedIds);
    await this._refreshTasks();
    this._bus.emit(EVENTS.TASKS_REORDERED, { orderedIds });
  }

  /**
   * Pliega o despliega un bloque. Es estado de interfaz, no de dominio: no se
   * persiste, cada sesión vuelve a abrir el bloque en curso.
   * @param {string} section
   */
  toggleSection(section) {
    const ui = this._store.getState().ui;
    const collapsed = new Set(ui.collapsedSections);
    if (collapsed.has(section)) collapsed.delete(section);
    else collapsed.add(section);
    this._store.patch('ui', { collapsedSections: [...collapsed] });
    this._bus.emit(EVENTS.SECTION_TOGGLED, { section, collapsed: collapsed.has(section) });
    return [...collapsed];
  }

  /** @param {Object} patch */
  async setPreferences(patch) {
    const preferences = await this._repository.savePreferences(patch);
    this._store.setState({ preferences });
    return preferences;
  }

  /**
   * Backup cifrado con AES-GCM a partir de la frase de paso del usuario.
   * @param {string} passphrase
   * @returns {Promise<import('../security/cryptoService.js').EncryptedEnvelope>}
   */
  async exportBackup(passphrase) {
    return this._repository.exportEncryptedBackup(passphrase);
  }

  /**
   * @param {string|Object} payload sobre cifrado o volcado en claro heredado.
   * @param {{passphrase?: string}} [options]
   * @returns {Promise<{tasks:number, logs:number, encrypted:boolean}>}
   */
  async importBackup(payload, options = {}) {
    const result = await this._repository.importBackup(payload, options);
    await this.hydrate();
    return result;
  }

  /** Borrado total de datos del usuario. */
  async wipe() {
    await this._repository.wipe();
    await this.hydrate();
  }

  /**
   * Escribe un registro de ejecución con **actualización optimista**: el store
   * recibe el log recalculado de inmediato y la transacción de IndexedDB se
   * resuelve después. Si falla, se revierte al log anterior y el error se
   * propaga para que la interfaz lo cuente.
   *
   * Marcar una tarea es la interacción más frecuente de la aplicación y llega
   * por gesto táctil: un retardo de 30 ms entre el dedo y el tachado se
   * percibe como que la app "no ha registrado" el toque.
   *
   * @param {import('./taskValidator.js').DailyLog} currentLog
   * @param {string} taskId
   * @param {Partial<import('./taskValidator.js').TaskExecutionRecord>} patch
   */
  async _writeEntry(currentLog, taskId, patch) {
    const entries = { ...currentLog.entries, [taskId]: createExecutionRecord(patch) };
    const optimistic = validateDailyLog({ ...currentLog, entries });
    const previousHistory = this._store.getState().history;

    this._applyLog(optimistic);
    try {
      const saved = await this._repository.saveLog(optimistic);
      this._applyLog(saved);
      return saved;
    } catch (error) {
      this._store.setState({ log: currentLog, history: previousHistory });
      this._bus.emit(EVENTS.ERROR, { scope: 'write-entry', taskId, error });
      throw error;
    }
  }

  /**
   * Publica un log en el store junto con su entrada de historial.
   * @param {import('./taskValidator.js').DailyLog} log
   */
  _applyLog(log) {
    this._store.setState({
      log,
      history: {
        ...this._store.getState().history,
        [log.date]: {
          completionRate: log.completionRate,
          completedCount: log.completedCount,
          totalActiveTasks: log.totalActiveTasks,
        },
      },
    });
  }

  /** Recarga tareas y re-sincroniza el divisor del día. */
  async _refreshTasks() {
    const tasks = await this._repository.listTasks();
    const today = this._store.getState().today;
    const log = await this._repository.ensureLog(today, countTasksForDay(tasks, today));
    this._store.setState({ tasks });
    this._applyLog(log);
    return tasks;
  }

  /**
   * Despliega el bloque indicado si estaba plegado. Se usa al guardar: una
   * tarea que cae en un bloque cerrado desaparecería nada más crearla.
   * @param {string} section
   */
  _expandSection(section) {
    const collapsed = this._store.getState().ui.collapsedSections;
    if (!collapsed.includes(section)) return;
    this._store.patch('ui', { collapsedSections: collapsed.filter((name) => name !== section) });
  }

  /**
   * Comprueba que la tarea existe y aplica hoy. Sin esta guarda, un comando
   * lanzado desde la consola o desde un render obsoleto podría marcar una
   * tarea de martes en jueves e inflar el numerador por encima del divisor.
   * @param {string} taskId
   * @param {import('../core/store.js').AppState} state
   * @returns {import('./taskValidator.js').TaskDefinition}
   */
  _requireActiveTask(taskId, state) {
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new ValidationError(`Tarea desconocida: ${taskId}`, [{ field: 'taskId', message: 'no existe' }]);
    }
    if (!isTaskActiveOn(task, state.today)) {
      throw new ValidationError(
        `«${task.title}» no aplica hoy`,
        [{ field: 'taskId', message: 'la tarea no está programada para este día' }],
      );
    }
    return task;
  }

  /** @returns {Promise<boolean>} */
  async _isFirstRun() {
    return !(await this._repository.getMeta('seeded_at'));
  }
}

/**
 * Bloques que arrancan plegados: todos los que tengan tareas hoy menos el que
 * está en curso.
 *
 * Si ningún bloque está en curso —a las 08:45 de un lunes, entre el arranque y
 * la jornada— se deja abierto el siguiente que tenga tareas; y si ya no queda
 * ninguno por delante, el último del día. Abrir la aplicación y encontrarla
 * entera plegada parece un error.
 *
 * @param {import('./taskValidator.js').TaskDefinition[]} tasks
 * @param {Date} [now]
 * @returns {string[]} identificadores de bloque plegados.
 */
export function defaultCollapsedSections(tasks, now = new Date()) {
  const schedule = resolveSchedule(now);
  const applicable = tasksForDay(tasks, now);
  const withTasks = schedule
    .filter((block) => applicable.some((task) => task.sectionId === block.id))
    .map((block) => block.id);
  if (withTasks.length <= 1) return [];

  const active = activeBlockId(now, schedule);
  let expanded = active !== null && withTasks.includes(active) ? active : null;

  if (expanded === null) {
    const minute = now.getHours() * 60 + now.getMinutes();
    const upcoming = schedule.find((block) => withTasks.includes(block.id) && block.isTimed && block.start > minute);
    expanded = upcoming?.id ?? withTasks[withTasks.length - 1];
  }

  return withTasks.filter((section) => section !== expanded);
}
