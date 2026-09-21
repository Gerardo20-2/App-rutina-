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

import { EVENTS, LIMITS, SECTIONS, SECTION_ORDER } from '../core/constants.js';
import { toDateKey, currentSection } from '../core/dateUtils.js';
import { createExecutionRecord, validateDailyLog, ValidationError } from './taskValidator.js';
import { buildHistory } from './selectors.js';
import { projectToday } from './streakCalculator.js';

/**
 * Rutina inicial del primer arranque: cuatro hábitos comunes, uno por bloque
 * del día.
 *
 * El número importa. Una lista vacía obliga a dar de alta tareas antes de ver
 * para qué sirve la aplicación, y una lista larga se percibe como deberes
 * ajenos. Cuatro caben en una pantalla, se completan el primer día y dejan la
 * racha en marcha desde el minuto uno; el usuario las edita o las archiva
 * cuando ya sabe qué quiere.
 */
export const SEED_TASKS = Object.freeze([
  { title: 'Beber un vaso de agua', section: SECTIONS.MORNING, estimatedMinutes: 1 },
  { title: 'Caminata de 15 min', section: SECTIONS.AFTERNOON, estimatedMinutes: 15 },
  { title: 'Dejar pantallas 30 min antes de dormir', section: SECTIONS.EVENING, estimatedMinutes: 30 },
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
      ui: {
        ...this._store.getState().ui,
        persistence: this._repository.engine,
        collapsedSections: defaultCollapsedSections(tasks),
      },
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
    this._expandSection(task.section);
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
   * Pliega o despliega un bloque del día. Es estado de interfaz, no de
   * dominio: no se persiste, cada sesión vuelve a abrir el bloque de la hora
   * actual.
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
   * Escribe un registro de ejecución con **actualización optimista**: el store
   * recibe el log recalculado de inmediato y la transacción de IndexedDB se
   * resuelve después. Si falla, se revierte al log anterior y el error se
   * propaga para que la interfaz lo cuente.
   *
   * El orden habitual de esta capa es persistir → actualizar → emitir; aquí se
   * invierte a propósito, porque una marca de tarea es la interacción más
   * frecuente de la aplicación y llega por gesto táctil: un retardo de 30 ms
   * entre el dedo y el tachado se percibe como que la app "no ha registrado"
   * el toque. La reversión mantiene la garantía de que el store no miente
   * durante más de una escritura fallida.
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

  /** Recarga tareas y re-sincroniza el total del log abierto. */
  async _refreshTasks() {
    const tasks = await this._repository.listTasks();
    const today = this._store.getState().today;
    const log = await this._repository.ensureLog(today, tasks.length);
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

  /** @returns {Promise<boolean>} */
  async _isFirstRun() {
    return !(await this._repository.getMeta('seeded_at'));
  }
}

/**
 * Bloques que arrancan plegados: todos menos el de la hora actual.
 *
 * Si el bloque de la hora actual no tiene tareas, se deja abierto el primero
 * que sí las tenga: abrir la app y encontrarla entera plegada parece un error.
 *
 * @param {import('./taskValidator.js').TaskDefinition[]} tasks
 * @param {Date} [now]
 * @returns {string[]} secciones plegadas.
 */
export function defaultCollapsedSections(tasks, now = new Date()) {
  const withTasks = SECTION_ORDER.filter((section) => tasks.some((task) => task.section === section));
  if (withTasks.length <= 1) return [];

  const active = currentSection(now);
  const expanded = withTasks.includes(active) ? active : withTasks[0];
  return withTasks.filter((section) => section !== expanded);
}
