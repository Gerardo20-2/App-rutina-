/**
 * @module domain/taskValidator
 * Contratos de datos y validación en frontera. Toda escritura a la capa de
 * persistencia pasa por aquí: IndexedDB acepta cualquier objeto serializable,
 * así que la integridad del esquema es responsabilidad del dominio.
 */

import { LIMITS, STREAK_CONFIG } from '../core/constants.js';
import { isDateKey, toDateKey, isTime, normalizeRange } from '../core/dateUtils.js';
import { isBlockId, getBlock, FALLBACK_BLOCK_ID } from './timeBlockService.js';

/**
 * @typedef {Object} TaskDefinition
 * @property {string} id               Identificador único: UUID v4 o slug estable.
 * @property {string} title            Nombre legible (máx. 80 caracteres).
 * @property {string} sectionId        Identificador del bloque horario.
 * @property {number[]} daysOfWeek     Días activos (0 = domingo … 6 = sábado). Vacío = todos.
 * @property {string} [timeStart]      Hora de referencia "HH:mm".
 * @property {string} [timeEnd]        Hora de fin "HH:mm".
 * @property {boolean} isAnchor        Bloque rígido (trabajo, clase, traslado).
 * @property {number} order            Posición ordinal dentro del bloque.
 * @property {boolean} isArchived      Flag de soft-delete.
 * @property {number} estimatedMinutes Duración estimada; se deduce del rango si falta.
 * @property {string} createdAt        Timestamp ISO 8601.
 */

/**
 * @typedef {Object} TaskExecutionRecord
 * @property {boolean} completed       Estado de ejecución.
 * @property {string|null} completedAt Timestamp ISO 8601 o null.
 * @property {boolean} skipped         Dispensada mediante swipe-left.
 */

/**
 * @typedef {Object} DailyLog
 * @property {string} date             Clave primaria YYYY-MM-DD.
 * @property {Object.<string, TaskExecutionRecord>} entries Mapa taskId -> registro.
 * @property {number} totalActiveTasks Tareas computables del día.
 * @property {number} completedCount   Tareas marcadas como completed.
 * @property {number} completionRate   completedCount / totalActiveTasks (0.0–1.0).
 * @property {boolean} closed          Procesado por el corte de medianoche.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
/** Identificador legible y estable, p. ej. `task-tue-class`. */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;

/**
 * Bloques genéricos de la v2, previos a la agenda por día. Sus tareas se
 * recogen en el cajón sin horario: cualquier otro destino les inventaría un
 * horario que el usuario nunca declaró.
 */
const LEGACY_SECTIONS = Object.freeze({
  morning: FALLBACK_BLOCK_ID,
  afternoon: FALLBACK_BLOCK_ID,
  evening: FALLBACK_BLOCK_ID,
  anytime: FALLBACK_BLOCK_ID,
});

/** Error de validación con detalle por campo. */
export class ValidationError extends Error {
  /**
   * @param {string} message
   * @param {Array<{field: string, message: string}>} issues
   */
  constructor(message, issues = []) {
    super(message);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

/**
 * UUID v4 criptográfico con degradación progresiva.
 * @returns {string}
 */
export function uuid() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // versión 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variante RFC 4122
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** @param {string} value */
export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Identificador de tarea admisible: UUID v4 (tareas creadas por el usuario) o
 * slug estable (semilla precargada).
 * @param {string} value
 */
export function isTaskId(value) {
  return isUuid(value) || (typeof value === 'string' && SLUG_RE.test(value));
}

/**
 * Normaliza `daysOfWeek`: enteros 0–6, sin duplicados y ordenados. Un array
 * con los siete días equivale a «todos», que se representa con el vacío.
 * @param {*} value
 * @returns {{days: number[], invalid: boolean}}
 */
export function normalizeDaysOfWeek(value) {
  if (value === undefined || value === null) return { days: [], invalid: false };
  if (!Array.isArray(value)) return { days: [], invalid: true };

  const days = [];
  let invalid = false;
  for (const entry of value) {
    const day = Number(entry);
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      invalid = true;
      continue;
    }
    if (!days.includes(day)) days.push(day);
  }
  days.sort((a, b) => a - b);
  return { days: days.length === 7 ? [] : days, invalid };
}

/** @param {string} value */
export function isIsoTimestamp(value) {
  return typeof value === 'string' && ISO_RE.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * Normaliza y valida una tarea. Devuelve una copia canónica: recorta el
 * título, fuerza tipos numéricos y rellena campos opcionales.
 * @param {Partial<TaskDefinition>} input
 * @param {{partial?: boolean}} [options] `partial: true` permite entradas nuevas sin id/createdAt.
 * @returns {TaskDefinition}
 * @throws {ValidationError}
 */
export function validateTask(input, options = {}) {
  const issues = [];
  if (!input || typeof input !== 'object') {
    throw new ValidationError('La tarea debe ser un objeto', [{ field: '', message: 'tipo inválido' }]);
  }

  const id = input.id ?? (options.partial ? uuid() : undefined);
  if (!isTaskId(id)) issues.push({ field: 'id', message: 'se esperaba un UUID v4 o un identificador estable' });

  const title = typeof input.title === 'string' ? input.title.trim().replace(/\s+/g, ' ') : '';
  if (title.length === 0) {
    issues.push({ field: 'title', message: 'el título es obligatorio' });
  } else if (title.length > LIMITS.TASK_TITLE_MAX) {
    issues.push({ field: 'title', message: `máximo ${LIMITS.TASK_TITLE_MAX} caracteres` });
  }

  // `section` es el campo de la v2: se acepta como alias para que un backup
  // antiguo o un registro sin migrar sigan siendo legibles.
  const rawSection = input.sectionId ?? LEGACY_SECTIONS[input.section] ?? input.section;
  const sectionId = rawSection ?? FALLBACK_BLOCK_ID;
  if (!isBlockId(sectionId)) {
    issues.push({ field: 'sectionId', message: `bloque desconocido: ${String(rawSection)}` });
  }

  const { days, invalid: badDays } = normalizeDaysOfWeek(input.daysOfWeek);
  if (badDays) issues.push({ field: 'daysOfWeek', message: 'se esperaban enteros de 0 (domingo) a 6 (sábado)' });

  const timeStart = input.timeStart ?? undefined;
  if (timeStart !== undefined && !isTime(timeStart)) {
    issues.push({ field: 'timeStart', message: 'se esperaba HH:mm' });
  }
  const timeEnd = input.timeEnd ?? undefined;
  if (timeEnd !== undefined && !isTime(timeEnd)) {
    issues.push({ field: 'timeEnd', message: 'se esperaba HH:mm' });
  }

  const order = Number(input.order ?? 0);
  if (!Number.isFinite(order) || order < 0) {
    issues.push({ field: 'order', message: 'debe ser un número finito >= 0' });
  }

  const createdAt = input.createdAt ?? (options.partial ? new Date().toISOString() : undefined);
  if (!isIsoTimestamp(createdAt)) {
    issues.push({ field: 'createdAt', message: 'se esperaba un timestamp ISO 8601' });
  }

  if (issues.length > 0) {
    throw new ValidationError(`Tarea inválida: ${issues.map((i) => `${i.field} (${i.message})`).join('; ')}`, issues);
  }

  // Duración: la declarada, o la que se deduce del rango horario.
  let estimatedMinutes = Number(input.estimatedMinutes);
  if (!Number.isFinite(estimatedMinutes) || estimatedMinutes < 0) {
    estimatedMinutes = timeStart && timeEnd ? spanMinutes(timeStart, timeEnd) : 5;
  }
  estimatedMinutes = Math.min(LIMITS.TASK_MINUTES_MAX, Math.round(estimatedMinutes));

  return {
    id,
    title,
    sectionId,
    daysOfWeek: days,
    ...(timeStart === undefined ? {} : { timeStart }),
    ...(timeEnd === undefined ? {} : { timeEnd }),
    // Por defecto, una tarea es rígida si su bloque lo es: las tareas de
    // trabajo, clase o traslado no se negocian.
    isAnchor: input.isAnchor === undefined ? Boolean(getBlock(sectionId)?.isAnchor) : Boolean(input.isAnchor),
    order: Math.trunc(order),
    estimatedMinutes,
    isArchived: Boolean(input.isArchived),
    createdAt,
  };
}

/**
 * Duración de un rango horario en minutos, tratando "00:00" como fin del día.
 * @param {string} start
 * @param {string} end
 * @returns {number}
 */
function spanMinutes(start, end) {
  const range = normalizeRange(start, end);
  return range.end - range.start;
}

/**
 * Crea una tarea nueva con valores por defecto validados.
 * @param {Partial<TaskDefinition>} input
 * @returns {TaskDefinition}
 */
export function createTask(input = {}) {
  return validateTask({ isArchived: false, ...input }, { partial: true });
}

/**
 * Registro de ejecución normalizado.
 * @param {Partial<TaskExecutionRecord>} [input]
 * @returns {TaskExecutionRecord}
 */
export function createExecutionRecord(input = {}) {
  const completed = Boolean(input.completed);
  const skipped = Boolean(input.skipped);
  return {
    // Invariante: una tarea dispensada nunca cuenta como completada.
    completed: completed && !skipped,
    completedAt: completed && !skipped ? (input.completedAt ?? new Date().toISOString()) : null,
    skipped,
  };
}

/**
 * Valida y recalcula los agregados de un log diario. `completedCount`,
 * `totalActiveTasks` y `completionRate` se derivan siempre de `entries`:
 * nunca se confía en los valores almacenados (pueden venir de una versión
 * previa o de un import manipulado).
 * @param {Partial<DailyLog>} input
 * @returns {DailyLog}
 * @throws {ValidationError}
 */
export function validateDailyLog(input) {
  const issues = [];
  if (!input || typeof input !== 'object') {
    throw new ValidationError('El log diario debe ser un objeto', [{ field: '', message: 'tipo inválido' }]);
  }
  if (!isDateKey(input.date)) {
    issues.push({ field: 'date', message: 'se esperaba YYYY-MM-DD' });
  }

  /** @type {Object.<string, TaskExecutionRecord>} */
  const entries = {};
  const rawEntries = input.entries && typeof input.entries === 'object' ? input.entries : {};
  for (const [taskId, record] of Object.entries(rawEntries)) {
    if (!isTaskId(taskId)) {
      issues.push({ field: `entries.${taskId}`, message: 'clave no es un identificador de tarea válido' });
      continue;
    }
    entries[taskId] = createExecutionRecord(record ?? {});
  }

  if (issues.length > 0) {
    throw new ValidationError(`Log diario inválido: ${issues.map((i) => `${i.field} (${i.message})`).join('; ')}`, issues);
  }

  const records = Object.values(entries);
  const skipped = records.filter((r) => r.skipped).length;
  const declaredTotal = Number(input.totalActiveTasks);
  const total = Number.isFinite(declaredTotal) && declaredTotal >= 0
    ? Math.trunc(declaredTotal)
    : records.length;
  // Las tareas dispensadas salen del denominador: un skip no penaliza.
  const computable = Math.max(0, total - skipped);
  // Con `entries` vacío (logs migrados desde la v1 o importados de un
  // backup agregado) se respeta el contador declarado; con registros
  // presentes, `entries` manda siempre.
  const declaredCompleted = Number(input.completedCount);
  const completedCount = records.length > 0
    ? records.filter((r) => r.completed).length
    : (Number.isFinite(declaredCompleted) && declaredCompleted >= 0
      ? Math.min(computable, Math.trunc(declaredCompleted))
      : 0);

  return {
    date: input.date,
    entries,
    totalActiveTasks: total,
    completedCount,
    completionRate: computable === 0 ? 0 : round4(Math.min(1, completedCount / computable)),
    closed: Boolean(input.closed),
  };
}

/**
 * Construye un log vacío para un día.
 * @param {string} date
 * @param {number} totalActiveTasks
 * @returns {DailyLog}
 */
export function createDailyLog(date = toDateKey(), totalActiveTasks = 0) {
  return validateDailyLog({ date, entries: {}, totalActiveTasks, closed: false });
}

/**
 * Valida el estado de racha, saneando rangos fuera de contrato.
 * @param {Partial<import('./streakCalculator.js').StreakState>} input
 * @returns {import('./streakCalculator.js').StreakState}
 */
export function validateStreakState(input) {
  const src = input && typeof input === 'object' ? input : {};
  const currentStreak = clampInt(src.currentStreak, 0, Number.MAX_SAFE_INTEGER, 0);
  const bestStreak = Math.max(currentStreak, clampInt(src.bestStreak, 0, Number.MAX_SAFE_INTEGER, 0));
  const lastEvaluatedDate = isDateKey(src.lastEvaluatedDate) ? src.lastEvaluatedDate : null;
  return {
    currentStreak,
    bestStreak,
    shieldsAvailable: clampInt(src.shieldsAvailable, 0, STREAK_CONFIG.MAX_SHIELDS, 0),
    shieldsUsedTotal: clampInt(src.shieldsUsedTotal, 0, Number.MAX_SAFE_INTEGER, 0),
    weightedConsistencyScore: clampFloat(src.weightedConsistencyScore, 0, 100, 0),
    lastEvaluatedDate,
  };
}

/**
 * Valida preferencias contra un mapa de valores por defecto (claves ajenas se descartan).
 * @param {Object} input
 * @param {Object} defaults
 */
export function validatePreferences(input, defaults) {
  const src = input && typeof input === 'object' ? input : {};
  /** @type {Object} */
  const out = { ...defaults };
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = src[key];
    if (value === undefined || value === null) continue;
    if (typeof fallback === 'boolean') out[key] = Boolean(value);
    else if (typeof fallback === 'number') out[key] = Number.isFinite(Number(value)) ? Number(value) : fallback;
    else if (typeof fallback === 'string') out[key] = String(value);
  }
  return out;
}

function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampFloat(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function round4(n) {
  return Math.round(n * 1e4) / 1e4;
}

export { round4 };
