/**
 * @module storage/repository
 * Fachada de dominio sobre el {@link StorageAdapter}. Es el único módulo que
 * conoce nombres de stores, índices y detalles de serialización; el resto de
 * la aplicación habla de tareas, logs y racha.
 *
 * Responsabilidades:
 *  - Selección de motor (IndexedDB → localStorage → memoria).
 *  - Validación en frontera (todo lo que entra y sale pasa por el validador).
 *  - Migración del estado monolítico v1 (`APP_STATE_V1` en localStorage).
 *  - Export/import de copias de seguridad en JSON.
 */

import { IndexedDbService } from './indexedDbService.js';
import { LocalStorageService } from './localStorageService.js';
import { StorageError } from './storageAdapter.js';
import {
  STORES,
  META_KEYS,
  LS_KEYS,
  DB_VERSION,
  DEFAULT_PREFERENCES,
  INITIAL_STREAK_STATE,
  SECTION_ORDER,
} from '../core/constants.js';
import {
  validateTask,
  validateDailyLog,
  validateStreakState,
  validatePreferences,
  createDailyLog,
  createTask,
  uuid,
  isUuid,
} from '../domain/taskValidator.js';
import { toDateKey, isDateKey, addDays } from '../core/dateUtils.js';

export class Repository {
  /** @param {{adapter?: import('./storageAdapter.js').StorageAdapter}} [options] */
  constructor(options = {}) {
    /** @type {import('./storageAdapter.js').StorageAdapter|null} */
    this._adapter = options.adapter ?? null;
    this._opened = false;
    /** @type {{legacyMigrated: boolean, upgraded: {from:number,to:number}|null}} */
    this.diagnostics = { legacyMigrated: false, upgraded: null };
  }

  /** @returns {string} motor efectivo. */
  get engine() {
    return this._adapter?.engine ?? 'none';
  }

  /**
   * Abre la persistencia con degradación progresiva.
   * @returns {Promise<Repository>}
   */
  async open() {
    if (this._opened) return this;

    if (!this._adapter) {
      if (await IndexedDbService.isSupported()) {
        this._adapter = new IndexedDbService();
      } else {
        console.warn('[Repository] IndexedDB no disponible, se usa el adaptador de respaldo');
        this._adapter = new LocalStorageService();
      }
    }

    try {
      await this._adapter.init();
    } catch (error) {
      if (this._adapter instanceof IndexedDbService) {
        console.warn('[Repository] fallo al abrir IndexedDB, se degrada a localStorage', error);
        this._adapter = new LocalStorageService();
        await this._adapter.init();
      } else {
        throw error;
      }
    }

    if (this._adapter instanceof IndexedDbService) {
      this.diagnostics.upgraded = this._adapter.lastUpgrade;
    }

    this._opened = true;
    await this._ensureMetadata();
    await this.migrateLegacy();
    return this;
  }

  /* ---------------------------------------------------------------- *
   * Tareas
   * ---------------------------------------------------------------- */

  /**
   * @param {{includeArchived?: boolean}} [options]
   * @returns {Promise<import('../domain/taskValidator.js').TaskDefinition[]>} ordenadas por sección y `order`.
   */
  async listTasks(options = {}) {
    const rows = await this._adapter.getAll(STORES.TASKS);
    const tasks = rows
      .map((row) => safeTask(row))
      .filter((task) => task !== null)
      .filter((task) => (options.includeArchived ? true : !task.isArchived));
    return sortTasks(tasks);
  }

  /**
   * Inserta o actualiza una tarea. Si no trae `order`, se coloca al final de
   * su sección.
   * @param {Partial<import('../domain/taskValidator.js').TaskDefinition>} input
   * @returns {Promise<import('../domain/taskValidator.js').TaskDefinition>}
   */
  async saveTask(input) {
    const existing = input.id ? await this._adapter.get(STORES.TASKS, input.id) : null;
    let draft;
    if (existing) {
      draft = validateTask({ ...stripInternal(existing), ...input });
    } else {
      const order = input.order ?? (await this._nextOrder(input.section ?? 'anytime'));
      draft = createTask({ ...input, order });
    }
    await this._adapter.put(STORES.TASKS, withInternal(draft));
    return draft;
  }

  /**
   * Soft-delete: la tarea desaparece de la vista pero los logs históricos que
   * la referencian siguen siendo interpretables.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async archiveTask(id) {
    const row = await this._adapter.get(STORES.TASKS, id);
    if (!row) return;
    const task = validateTask({ ...stripInternal(row), isArchived: true });
    await this._adapter.put(STORES.TASKS, withInternal(task));
  }

  /** @param {string} id */
  async restoreTask(id) {
    const row = await this._adapter.get(STORES.TASKS, id);
    if (!row) return;
    const task = validateTask({ ...stripInternal(row), isArchived: false });
    await this._adapter.put(STORES.TASKS, withInternal(task));
  }

  /** Borrado definitivo (sólo desde la gestión de datos). @param {string} id */
  async deleteTask(id) {
    await this._adapter.delete(STORES.TASKS, id);
  }

  /**
   * Reordena asignando `order` consecutivo según la posición en el array.
   * @param {string[]} orderedIds
   * @returns {Promise<void>}
   */
  async reorderTasks(orderedIds) {
    const rows = await this._adapter.getAll(STORES.TASKS);
    const byId = new Map(rows.map((row) => [row.id, row]));
    /** @type {Array<*>} */
    const updated = [];
    orderedIds.forEach((id, index) => {
      const row = byId.get(id);
      if (!row) return;
      updated.push(withInternal(validateTask({ ...stripInternal(row), order: index })));
    });
    await this._adapter.bulkPut(STORES.TASKS, updated);
  }

  /* ---------------------------------------------------------------- *
   * Logs diarios
   * ---------------------------------------------------------------- */

  /**
   * @param {string} date
   * @returns {Promise<import('../domain/taskValidator.js').DailyLog|null>}
   */
  async getLog(date) {
    const row = await this._adapter.get(STORES.DAILY_LOGS, date);
    if (!row) return null;
    try {
      return validateDailyLog(row);
    } catch (error) {
      console.warn(`[Repository] log "${date}" inválido, se ignora`, error);
      return null;
    }
  }

  /**
   * Obtiene el log del día, creándolo si no existe.
   * @param {string} date
   * @param {number} totalActiveTasks
   * @returns {Promise<import('../domain/taskValidator.js').DailyLog>}
   */
  async ensureLog(date, totalActiveTasks) {
    const existing = await this.getLog(date);
    if (existing) {
      // El total se re-sincroniza: el usuario pudo añadir o archivar tareas hoy.
      if (!existing.closed && existing.totalActiveTasks !== totalActiveTasks) {
        return this.saveLog({ ...existing, totalActiveTasks });
      }
      return existing;
    }
    return this.saveLog(createDailyLog(date, totalActiveTasks));
  }

  /**
   * @param {Partial<import('../domain/taskValidator.js').DailyLog>} log
   * @returns {Promise<import('../domain/taskValidator.js').DailyLog>}
   */
  async saveLog(log) {
    const validated = validateDailyLog(log);
    await this._adapter.put(STORES.DAILY_LOGS, validated);
    return validated;
  }

  /**
   * @param {string} from  inclusive
   * @param {string} to    inclusive
   * @returns {Promise<import('../domain/taskValidator.js').DailyLog[]>} ordenados ascendentemente.
   */
  async listLogs(from, to) {
    const rows = await this._adapter.getAll(STORES.DAILY_LOGS, { range: { lower: from, upper: to } });
    return rows
      .filter((row) => isDateKey(row?.date) && row.date >= from && row.date <= to)
      .map((row) => {
        try {
          return validateDailyLog(row);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  /**
   * @param {number} days ventana hacia atrás desde `today` (incluido).
   * @param {string} [today]
   */
  async recentLogs(days, today = toDateKey()) {
    return this.listLogs(addDays(today, -(days - 1)), today);
  }

  /* ---------------------------------------------------------------- *
   * Metadatos del sistema
   * ---------------------------------------------------------------- */

  /** @param {string} key @returns {Promise<*>} */
  async getMeta(key) {
    const row = await this._adapter.get(STORES.SYSTEM_METADATA, key);
    return row?.value;
  }

  /** @param {string} key @param {*} value */
  async setMeta(key, value) {
    await this._adapter.put(STORES.SYSTEM_METADATA, { key, value, updatedAt: new Date().toISOString() });
    return value;
  }

  /** @returns {Promise<import('../domain/streakCalculator.js').StreakState>} */
  async getStreak() {
    return validateStreakState(await this.getMeta(META_KEYS.STREAK_STATE));
  }

  /** @param {import('../domain/streakCalculator.js').StreakState} state */
  async saveStreak(state) {
    const validated = validateStreakState(state);
    await this.setMeta(META_KEYS.STREAK_STATE, validated);
    return validated;
  }

  async getPreferences() {
    return validatePreferences(await this.getMeta(META_KEYS.USER_PREFERENCES), DEFAULT_PREFERENCES);
  }

  /** @param {Object} prefs */
  async savePreferences(prefs) {
    const merged = validatePreferences({ ...(await this.getPreferences()), ...prefs }, DEFAULT_PREFERENCES);
    await this.setMeta(META_KEYS.USER_PREFERENCES, merged);
    return merged;
  }

  /* ---------------------------------------------------------------- *
   * Copias de seguridad y migración
   * ---------------------------------------------------------------- */

  /** @returns {Promise<Object>} volcado serializable. */
  async exportBackup() {
    const dump = await this._adapter.exportAll();
    return { app: 'routine-tracker', schema: DB_VERSION, ...dump };
  }

  /**
   * @param {Object|string} payload volcado (objeto o JSON).
   * @returns {Promise<{tasks:number, logs:number}>}
   */
  async importBackup(payload) {
    const dump = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (!dump?.data || typeof dump.data !== 'object') {
      throw new StorageError('El archivo no contiene un volcado válido', { code: 'BAD_DUMP' });
    }
    // Se valida ANTES de tocar la base: un import corrupto no debe dejar
    // el almacenamiento a medias.
    const tasks = (dump.data[STORES.TASKS] ?? [])
      .map((row) => safeTask(row))
      .filter(Boolean)
      .map(withInternal);
    const logs = (dump.data[STORES.DAILY_LOGS] ?? [])
      .map((row) => {
        try {
          return validateDailyLog(row);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const metadata = (dump.data[STORES.SYSTEM_METADATA] ?? []).filter((row) => typeof row?.key === 'string');

    await this._adapter.importAll({
      version: DB_VERSION,
      data: {
        [STORES.TASKS]: tasks,
        [STORES.DAILY_LOGS]: logs,
        [STORES.SYSTEM_METADATA]: metadata.length > 0 ? metadata : await this._adapter.getAll(STORES.SYSTEM_METADATA),
      },
    });
    await this._ensureMetadata();
    return { tasks: tasks.length, logs: logs.length };
  }

  /**
   * Convierte el estado monolítico `APP_STATE_V1` de localStorage al esquema
   * v2. Idempotente: marca la clave como consumida al terminar.
   * @returns {Promise<boolean>} `true` si hubo migración.
   */
  async migrateLegacy() {
    let raw = null;
    try {
      raw = globalThis.localStorage?.getItem(LS_KEYS.LEGACY_APP_STATE) ?? null;
    } catch {
      return false;
    }
    if (!raw) return false;

    let legacy;
    try {
      legacy = JSON.parse(raw);
    } catch (error) {
      console.warn('[Repository] APP_STATE_V1 ilegible, se descarta', error);
      safeRemoveLegacy();
      return false;
    }

    const today = toDateKey();
    const existingTasks = await this._adapter.getAll(STORES.TASKS);
    /** @type {Array<*>} */
    const tasks = [];
    /** @type {Map<string,string>} legacyId -> uuid */
    const idMap = new Map();

    (Array.isArray(legacy?.tasks) ? legacy.tasks : []).forEach((legacyTask, index) => {
      const id = isUuid(legacyTask?.id) ? legacyTask.id : uuid();
      if (legacyTask?.id) idMap.set(String(legacyTask.id), id);
      try {
        tasks.push(withInternal(createTask({
          id,
          title: legacyTask?.title,
          section: SECTION_ORDER.includes(legacyTask?.section) ? legacyTask.section : 'anytime',
          order: Number.isFinite(Number(legacyTask?.order)) ? Number(legacyTask.order) : index,
          estimatedMinutes: 5,
          isArchived: false,
          createdAt: new Date().toISOString(),
        })));
      } catch (error) {
        console.warn('[Repository] tarea v1 descartada', legacyTask, error);
      }
    });

    // El día en curso de la v1 conserva qué tareas estaban marcadas.
    /** @type {Array<*>} */
    const logs = [];
    const lastActive = isDateKey(legacy?.lastActiveDate) ? legacy.lastActiveDate : today;
    const entries = {};
    (Array.isArray(legacy?.tasks) ? legacy.tasks : []).forEach((legacyTask) => {
      const id = idMap.get(String(legacyTask?.id));
      if (!id) return;
      entries[id] = {
        completed: Boolean(legacyTask?.completed),
        completedAt: legacyTask?.completed ? new Date().toISOString() : null,
        skipped: false,
      };
    });
    if (Object.keys(entries).length > 0) {
      logs.push(validateDailyLog({
        date: lastActive,
        entries,
        totalActiveTasks: tasks.length,
        closed: lastActive !== today,
      }));
    }

    for (const [date, summary] of Object.entries(legacy?.history ?? {})) {
      if (!isDateKey(date) || date === lastActive) continue;
      const total = Math.max(0, Math.trunc(Number(summary?.totalCount ?? 0)));
      logs.push(validateDailyLog({
        date,
        entries: {},
        totalActiveTasks: total,
        completedCount: Math.max(0, Math.trunc(Number(summary?.completedCount ?? 0))),
        closed: true,
      }));
    }

    const legacyStreak = validateStreakState({
      currentStreak: legacy?.streak?.current,
      bestStreak: legacy?.streak?.best,
      shieldsAvailable: 0,
      shieldsUsedTotal: 0,
      weightedConsistencyScore: 0,
      lastEvaluatedDate: isDateKey(legacy?.streak?.lastCompletedDate)
        ? legacy.streak.lastCompletedDate
        : (isDateKey(legacy?.lastActiveDate) ? addDays(legacy.lastActiveDate, -1) : null),
    });

    // Sólo se importan tareas si la base v2 está vacía: si el usuario ya
    // trabajó en la v2, el estado nuevo manda.
    if (existingTasks.length === 0 && tasks.length > 0) {
      await this._adapter.bulkPut(STORES.TASKS, tasks);
    }
    if (logs.length > 0) {
      const fresh = [];
      for (const log of logs) {
        if (!(await this.getLog(log.date))) fresh.push(log);
      }
      if (fresh.length > 0) await this._adapter.bulkPut(STORES.DAILY_LOGS, fresh);
    }
    const currentStreak = await this.getStreak();
    if (currentStreak.lastEvaluatedDate === null && legacyStreak.bestStreak > 0) {
      await this.saveStreak(legacyStreak);
    }

    safeRemoveLegacy();
    this.diagnostics.legacyMigrated = true;
    return true;
  }

  /** Borra todos los datos del usuario (acción destructiva, confirmada en UI). */
  async wipe() {
    for (const store of [STORES.TASKS, STORES.DAILY_LOGS, STORES.SYSTEM_METADATA]) {
      await this._adapter.clear(store);
    }
    await this._ensureMetadata();
  }

  async close() {
    await this._adapter?.close();
    this._opened = false;
  }

  /** Crea las claves obligatorias de `system_metadata` si faltan. */
  async _ensureMetadata() {
    if ((await this.getMeta(META_KEYS.SCHEMA_VERSION)) !== DB_VERSION) {
      await this.setMeta(META_KEYS.SCHEMA_VERSION, DB_VERSION);
    }
    if (!(await this.getMeta(META_KEYS.STREAK_STATE))) {
      await this.setMeta(META_KEYS.STREAK_STATE, { ...INITIAL_STREAK_STATE });
    }
    if (!(await this.getMeta(META_KEYS.USER_PREFERENCES))) {
      await this.setMeta(META_KEYS.USER_PREFERENCES, { ...DEFAULT_PREFERENCES });
    }
  }

  /** @param {string} section @returns {Promise<number>} */
  async _nextOrder(section) {
    const tasks = await this.listTasks({ includeArchived: true });
    const inSection = tasks.filter((task) => task.section === section);
    return inSection.length === 0 ? 0 : Math.max(...inSection.map((t) => t.order)) + 1;
  }
}

/**
 * IndexedDB no indexa booleanos: se persiste `archivedFlag` (0/1) como campo
 * espejo para poder consultar por `idx_archived`.
 * @param {import('../domain/taskValidator.js').TaskDefinition} task
 */
function withInternal(task) {
  return { ...task, archivedFlag: task.isArchived ? 1 : 0 };
}

function stripInternal(row) {
  const { archivedFlag, ...rest } = row ?? {};
  return rest;
}

function safeTask(row) {
  try {
    return validateTask(stripInternal(row));
  } catch (error) {
    console.warn('[Repository] tarea inválida descartada', row, error);
    return null;
  }
}

/**
 * Orden canónico: bloque del día y, dentro de él, el `order` manual.
 * @param {import('../domain/taskValidator.js').TaskDefinition[]} tasks
 */
export function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const sectionDelta = SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section);
    if (sectionDelta !== 0) return sectionDelta;
    if (a.order !== b.order) return a.order - b.order;
    return a.createdAt < b.createdAt ? -1 : 1;
  });
}

function safeRemoveLegacy() {
  try {
    globalThis.localStorage?.removeItem(LS_KEYS.LEGACY_APP_STATE);
  } catch { /* noop */ }
}

/** Repositorio compartido por la aplicación. */
export const repository = new Repository();
