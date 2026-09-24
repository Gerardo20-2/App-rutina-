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
 *  - Export/import de copias de seguridad, cifradas con AES-GCM
 *    (`security/cryptoService.js`) y parseadas sin claves de prototipo.
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
} from '../core/constants.js';
import { BLOCK_IDS, FALLBACK_BLOCK_ID, isBlockId } from '../domain/timeBlockService.js';
import {
  validateTask,
  validateDailyLog,
  validateStreakState,
  validatePreferences,
  createDailyLog,
  createTask,
  uuid,
  isTaskId,
} from '../domain/taskValidator.js';
import { toDateKey, isDateKey, addDays, parseTime } from '../core/dateUtils.js';
import { safeJsonParse, sanitizeDeep } from '../security/objectGuard.js';
import { encryptJson, decryptJson, isEncryptedEnvelope } from '../security/cryptoService.js';

/** Metadatos que un backup puede restaurar; cualquier otra clave se ignora. */
const IMPORTABLE_META_KEYS = new Set(Object.values(META_KEYS));

export class Repository {
  /** @param {{adapter?: import('./storageAdapter.js').StorageAdapter}} [options] */
  constructor(options = {}) {
    /** @type {import('./storageAdapter.js').StorageAdapter|null} */
    this._adapter = options.adapter ?? null;
    this._opened = false;
    /** @type {{legacyMigrated: boolean, upgraded: {from:number,to:number}|null, schemaMigrated: Object|null}} */
    this.diagnostics = { legacyMigrated: false, upgraded: null, schemaMigrated: null };
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
    // La versión almacenada se lee ANTES de que `_ensureMetadata` la reescriba.
    const storedVersion = await this.getMeta(META_KEYS.SCHEMA_VERSION);
    await this._ensureMetadata();
    await this.migrateSchema(storedVersion);
    await this.migrateLegacy();
    return this;
  }

  /**
   * Migración de datos entre versiones del esquema. La v3 añade agenda por día
   * a las tareas: `sectionId`, `daysOfWeek`, `timeStart/End` e `isAnchor`.
   *
   * Los bloques genéricos de la v2 (`morning`, `afternoon`, `evening`,
   * `anytime`) no tienen equivalente en la agenda real —nadie declaró a qué
   * hora eran—, así que sus tareas se recogen en el cajón sin horario, donde
   * siguen visibles todos los días y el usuario puede reasignarlas.
   *
   * @param {*} storedVersion versión leída de `system_metadata`.
   * @returns {Promise<number>} tareas migradas.
   */
  async migrateSchema(storedVersion) {
    const rows = await this._adapter.getAll(STORES.TASKS);
    const pending = rows.filter((row) => row && (!isBlockId(row.sectionId) || row.section !== undefined));
    if (pending.length === 0) return 0;

    /** @type {Array<*>} */
    const migrated = [];
    for (const row of rows) {
      try {
        const { section, ...rest } = stripInternal(row);
        migrated.push(withInternal(validateTask({
          ...rest,
          sectionId: isBlockId(rest.sectionId) ? rest.sectionId : FALLBACK_BLOCK_ID,
          daysOfWeek: rest.daysOfWeek ?? [],
        })));
      } catch (error) {
        console.warn('[Repository] tarea descartada al migrar a la v3', row, error);
      }
    }
    await this._adapter.bulkPut(STORES.TASKS, migrated);
    this.diagnostics.schemaMigrated = { from: Number(storedVersion) || 2, to: DB_VERSION, tasks: pending.length };
    return pending.length;
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
      const order = input.order ?? (await this._nextOrder(input.sectionId ?? FALLBACK_BLOCK_ID));
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

  /** @returns {Promise<Object>} volcado serializable, en claro. */
  async exportBackup() {
    const dump = await this._adapter.exportAll();
    return { app: 'routine-tracker', schema: DB_VERSION, ...dump };
  }

  /**
   * Volcado cifrado: la única forma de backup que ofrece la interfaz.
   * @param {string} passphrase
   * @returns {Promise<import('../security/cryptoService.js').EncryptedEnvelope>}
   */
  async exportEncryptedBackup(passphrase) {
    return encryptJson(await this.exportBackup(), passphrase);
  }

  /**
   * Acepta un sobre cifrado (requiere `passphrase`) o, por compatibilidad con
   * copias anteriores, un volcado en claro. En ambos casos el JSON se parsea
   * sin `__proto__`/`constructor`/`prototype` y cada fila se revalida.
   * @param {Object|string} payload volcado (objeto o JSON).
   * @param {{passphrase?: string}} [options]
   * @returns {Promise<{tasks:number, logs:number, encrypted:boolean}>}
   */
  async importBackup(payload, options = {}) {
    let dump;
    try {
      dump = typeof payload === 'string' ? safeJsonParse(payload) : sanitizeDeep(payload);
    } catch (error) {
      throw new StorageError('El archivo no es JSON válido', { cause: error, code: 'BAD_DUMP' });
    }
    const encrypted = isEncryptedEnvelope(dump);
    if (encrypted) {
      if (!options.passphrase) {
        throw new StorageError('Copia cifrada: hace falta la frase de paso', { code: 'PASSPHRASE_REQUIRED' });
      }
      dump = await decryptJson(dump, options.passphrase);
    }
    if (!dump?.data || typeof dump.data !== 'object' || Array.isArray(dump.data)) {
      throw new StorageError('El archivo no contiene un volcado válido', { code: 'BAD_DUMP' });
    }
    const rows = (store) => (Array.isArray(dump.data[store]) ? dump.data[store] : []);
    // Se valida ANTES de tocar la base: un import corrupto no debe dejar
    // el almacenamiento a medias.
    const tasks = rows(STORES.TASKS)
      .map((row) => safeTask(row))
      .filter(Boolean)
      .map(withInternal);
    const logs = rows(STORES.DAILY_LOGS)
      .map((row) => {
        try {
          return validateDailyLog(row);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const metadata = rows(STORES.SYSTEM_METADATA)
      .filter((row) => typeof row?.key === 'string' && IMPORTABLE_META_KEYS.has(row.key));

    await this._adapter.importAll({
      version: DB_VERSION,
      data: {
        [STORES.TASKS]: tasks,
        [STORES.DAILY_LOGS]: logs,
        [STORES.SYSTEM_METADATA]: metadata.length > 0 ? metadata : await this._adapter.getAll(STORES.SYSTEM_METADATA),
      },
    });
    await this._ensureMetadata();
    return { tasks: tasks.length, logs: logs.length, encrypted };
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
      legacy = safeJsonParse(raw);
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
      const id = isTaskId(legacyTask?.id) ? legacyTask.id : uuid();
      if (legacyTask?.id) idMap.set(String(legacyTask.id), id);
      try {
        tasks.push(withInternal(createTask({
          id,
          title: legacyTask?.title,
          // La v1 no tenía agenda: sus tareas van al cajón sin horario.
          sectionId: FALLBACK_BLOCK_ID,
          daysOfWeek: [],
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

  /** @param {string} sectionId @returns {Promise<number>} */
  async _nextOrder(sectionId) {
    const tasks = await this.listTasks({ includeArchived: true });
    const inBlock = tasks.filter((task) => task.sectionId === sectionId);
    return inBlock.length === 0 ? 0 : Math.max(...inBlock.map((task) => task.order)) + 1;
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
 * Orden canónico: bloque, después la hora de referencia y, a igualdad, el
 * `order` manual. Ordenar por hora dentro del bloque evita que dos tareas con
 * el mismo `order` aparezcan en orden arbitrario, y hace que la lista siga la
 * secuencia real del día.
 * @param {import('../domain/taskValidator.js').TaskDefinition[]} tasks
 */
export function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const blockDelta = BLOCK_IDS.indexOf(a.sectionId) - BLOCK_IDS.indexOf(b.sectionId);
    if (blockDelta !== 0) return blockDelta;
    if (a.order !== b.order) return a.order - b.order;
    const timeDelta = startMinutes(a) - startMinutes(b);
    if (timeDelta !== 0) return timeDelta;
    return a.createdAt < b.createdAt ? -1 : 1;
  });
}

/** Hora de referencia en minutos; las tareas sin hora van al final del bloque. */
function startMinutes(task) {
  try {
    return task.timeStart ? parseTime(task.timeStart) : Number.MAX_SAFE_INTEGER;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function safeRemoveLegacy() {
  try {
    globalThis.localStorage?.removeItem(LS_KEYS.LEGACY_APP_STATE);
  } catch { /* noop */ }
}

/** Repositorio compartido por la aplicación. */
export const repository = new Repository();
