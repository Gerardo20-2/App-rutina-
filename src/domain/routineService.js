/**
 * @module domain/routineService
 * Servicio de aplicación: único punto donde se originan mutaciones del estado
 * persistido. La UI despacha comandos (`toggleTask`, `skipTask`, …) y el
 * servicio se encarga de validar, persistir, actualizar el store y emitir los
 * eventos de dominio. Ningún componente escribe en el repositorio.
 *
 * Orden de operaciones de todo comando: **persistir → actualizar store →
 * emitir evento**. Si la escritura falla, el store no miente al usuario.
 */

import { EVENTS, LIMITS, SECTIONS } from '../core/constants.js';
import { toDateKey, currentSection } from '../core/dateUtils.js';
import { createExecutionRecord, validateDailyLog, ValidationError } from './taskValidator.js';
import { buildHistory } from './selectors.js';
import { projectToday } from './streakCalculator.js';

/** Rutina inicial sugerida en el primer arranque. */
export const SEED_TASKS = Object.freeze([
  { title: 'Beber un vaso de agua', section: SECTIONS.MORNING, estimatedMinutes: 1 },
  { title: 'Meditación 10 min', section: SECTIONS.MORNING, estimatedMinutes: 10 },
  { title: 'Revisar las 3 prioridades del día', section: SECTIONS.MORNING, estimatedMinutes: 5 },
  { title: 'Caminar 20 min', section: SECTIONS.AFTERNOON, estimatedMinutes: 20 },
  { title: 'Leer 15 páginas', section: SECTIONS.EVENING, estimatedMinutes: 20 },
  { title: 'Preparar la mochila de mañana', section: SECTIONS.EVENING, estimatedMinutes: 5 },
  { title: 'Estirar la espalda', section: SECTIONS.ANYTIME, estimatedMinutes: 5 },
]);

export class RoutineService {
  /**
   * @param {{
   *   repository: import('../storage/repository.js').Repository,
   *   store: import('../core/store.js').Store,
   *   bus: import('../core/events.js').EventBus,
   * }} deps
   */
  constructor({ repository, store, bus }) {
    this._repository = repository;
    this._store = store;
    this._bus = bus;
  }

  /**
   * Carga el estado persistido en el store. Siembra la rutina por defecto en
   * el primer arranque.
   * @returns {Promise<void>}
   */
  async hydrate() {
    const today = toDateKey();
    let tasks = await this._repository.listTasks();

    if (tasks.length === 0 && (await this._isFirstRun())) {
      await this.seedDefaults();
      tasks = await this._repository.listTasks();
    }

    const [log, streak, preferences, logs] = await Promise.all([
      this._repository.ensureLog(today, tasks.length),
      this._repository.getStreak(),
      this._repository.getPreferences(),
      this._repository.recentLogs(LIMITS.HEATMAP_WEEKS * 7, today),
    ]);

    this._store.setState({
      ready: true,
      today,
      tasks,
      log,
      streak,
      preferences,
      history: buildHistory(logs),
      ui: { ...this._store.getState().ui, persistence: this._repository.engine },
    });
    this._bus.emit(EVENTS.READY, { engine: this._repository.engine, tasks: tasks.length });
  }

  /** Inserta la rutina inicial. @returns {Promise<void>} */
  async seedDefaults() {
    let order = 0;
    for (const seed of SEED_TASKS) {
      await this._repository.saveTask({ ...seed, order: order++ });
    }
    await this._repository.setMeta('seeded_at', new Date().toISOString());
  }

  /**
   * Marca/desmarca una tarea en el día activo.
   * @param {string} taskId
   * @param {boolean} [force] valor explícito; si se omite, alterna.
   * @returns {Promise<import('./taskValidator.js').DailyLog>}
   */
  async toggleTask(taskId, force) {
    const state = this._store.getState();
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) throw new ValidationError(`Tarea desconocida: ${taskId}`, [{ field: 'taskId', message: 'no existe' }]);

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
    if (!draft.id && !draft.section) draft.section = currentSection();
    const task = await this._repository.saveTask(draft);
    await this._refreshTasks();
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

  /** @param {Object} patch */
  async setPreferences(patch) {
    const preferences = await this._repository.savePreferences(patch);
    this._store.setState({ preferences });
    return preferences;
  }

  /** @returns {Promise<Object>} */
  async exportBackup() {
    return this._repository.exportBackup();
  }

  /**
   * @param {string|Object} payload
   * @returns {Promise<{tasks:number, logs:number}>}
   */
  async importBackup(payload) {
    const result = await this._repository.importBackup(payload);
    await this.hydrate();
    return result;
  }

  /** Borrado total de datos del usuario. */
  async wipe() {
    await this._repository.wipe();
    await this.hydrate();
  }

  /**
   * Escribe un registro de ejecución y propaga el log recalculado.
   * @param {import('./taskValidator.js').DailyLog} currentLog
   * @param {string} taskId
   * @param {Partial<import('./taskValidator.js').TaskExecutionRecord>} patch
   */
  async _writeEntry(currentLog, taskId, patch) {
    const entries = { ...currentLog.entries, [taskId]: createExecutionRecord(patch) };
    const next = validateDailyLog({ ...currentLog, entries });
    const saved = await this._repository.saveLog(next);
    this._store.setState({
      log: saved,
      history: { ...this._store.getState().history, [saved.date]: {
        completionRate: saved.completionRate,
        completedCount: saved.completedCount,
        totalActiveTasks: saved.totalActiveTasks,
      } },
    });
    return saved;
  }

  /** Recarga tareas y re-sincroniza el total del log abierto. */
  async _refreshTasks() {
    const tasks = await this._repository.listTasks();
    const today = this._store.getState().today;
    const log = await this._repository.ensureLog(today, tasks.length);
    this._store.setState({
      tasks,
      log,
      history: { ...this._store.getState().history, [log.date]: {
        completionRate: log.completionRate,
        completedCount: log.completedCount,
        totalActiveTasks: log.totalActiveTasks,
      } },
    });
    return tasks;
  }

  /** @returns {Promise<boolean>} */
  async _isFirstRun() {
    return !(await this._repository.getMeta('seeded_at'));
  }
}
