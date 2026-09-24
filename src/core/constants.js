/**
 * @module core/constants
 * Configuración base, claves de persistencia y enumeraciones del dominio.
 * Todo valor "mágico" del sistema vive aquí: ningún otro módulo debe declarar
 * literales de configuración.
 */

import { deepFreeze } from '../security/objectGuard.js';

// Los catálogos se congelan en profundidad: un `Object.freeze` superficial
// dejaría mutables las listas anidadas, p. ej. los patrones de vibración.

/* ------------------------------------------------------------------ *
 * Persistencia
 * ------------------------------------------------------------------ */

/** @type {string} Nombre de la base IndexedDB. */
export const DB_NAME = 'routine_tracker_db';

/**
 * @type {number} Versión del esquema IndexedDB.
 *   v2 — tasks + daily_logs + system_metadata con bloques genéricos.
 *   v3 — bloques horarios por día: `sectionId`, `daysOfWeek`, `timeStart/End`, `isAnchor`.
 */
export const DB_VERSION = 3;

/** Nombres de object stores. @enum {string} */
export const STORES = deepFreeze({
  TASKS: 'tasks',
  DAILY_LOGS: 'daily_logs',
  SYSTEM_METADATA: 'system_metadata',
  /** Store legado de la v1, se lee sólo durante la migración. */
  LEGACY_APP_STATE: 'app_state',
});

/** Índices declarados por store. @enum {Object.<string,string>} */
export const INDICES = deepFreeze({
  [STORES.TASKS]: Object.freeze({
    idx_section: 'sectionId',
    idx_order: 'order',
    idx_archived: 'isArchived',
  }),
  [STORES.DAILY_LOGS]: Object.freeze({
    idx_completion_rate: 'completionRate',
  }),
});

/** Claves obligatorias del store `system_metadata`. @enum {string} */
export const META_KEYS = deepFreeze({
  STREAK_STATE: 'streak_state',
  USER_PREFERENCES: 'user_preferences',
  SCHEMA_VERSION: 'schema_version',
});

/** Claves usadas en `localStorage` (fallback y migración desde la v1). @enum {string} */
export const LS_KEYS = deepFreeze({
  /** Estado monolítico de la arquitectura v1. */
  LEGACY_APP_STATE: 'APP_STATE_V1',
  /** Prefijo del adaptador de respaldo `localStorageService`. */
  NAMESPACE: 'routine_tracker_v2',
});

/** Identificador del caché del Service Worker (sincronizado manualmente con `public/sw.js`). */
export const CACHE_NAME = 'routine-tracker-v4';

/* ------------------------------------------------------------------ *
 * Dominio
 * ------------------------------------------------------------------ */

/**
 * Los bloques del día ya no son una enumeración fija de cuatro valores: son la
 * agenda real del usuario, condicionada por el día de la semana, y viven en
 * `src/domain/timeBlockService.js` (`BLOCK_CATALOG`). Aquí sólo quedan los
 * parámetros que no dependen de esa agenda.
 */

/** Resultado de la evaluación de un día cerrado. @enum {string} */
export const DAY_OUTCOME = deepFreeze({
  /** r >= THRESHOLD_SUCCESS — el día extiende la racha. */
  SUCCESS: 'SUCCESS',
  /** THRESHOLD_PARTIAL <= r < THRESHOLD_SUCCESS — la racha se conserva sin incrementarse. */
  PARTIAL: 'PARTIAL',
  /** r < THRESHOLD_PARTIAL — rompe la racha salvo que se consuma un escudo. */
  FAIL: 'FAIL',
  /** Día sin tareas computables: neutro, no afecta la racha ni el score. */
  VOID: 'VOID',
});

/** Transiciones aplicadas por el calculador de rachas. @enum {string} */
export const STREAK_TRANSITION = deepFreeze({
  EXTENDED: 'EXTENDED',
  PRESERVED_PARTIAL: 'PRESERVED_PARTIAL',
  PRESERVED_BY_SHIELD: 'PRESERVED_BY_SHIELD',
  BROKEN: 'BROKEN',
  SKIPPED_VOID: 'SKIPPED_VOID',
});

/** Estados del `dayResetService`. @enum {string} */
export const RESET_STATE = deepFreeze({
  IDLE: 'IDLE',
  SCHEDULED: 'SCHEDULED',
  EVALUATING: 'EVALUATING',
  RECONCILING: 'RECONCILING',
  /** El reloj retrocedió por debajo del último día evaluado: cálculo congelado. */
  FROZEN: 'FROZEN',
  ERROR: 'ERROR',
});

/* ------------------------------------------------------------------ *
 * Parámetros del algoritmo de racha resiliente
 * ------------------------------------------------------------------ */

export const STREAK_CONFIG = deepFreeze({
  /** τ_success — ratio mínimo para considerar el día exitoso. */
  THRESHOLD_SUCCESS: 0.8,
  /** τ_partial — ratio mínimo para conservar la racha sin extenderla. */
  THRESHOLD_PARTIAL: 0.5,
  /** Escudos máximos acumulables. */
  MAX_SHIELDS: 3,
  /** Un escudo nuevo por cada N días consecutivos de éxito. */
  SHIELD_EARN_INTERVAL: 7,
  /** Ventana W del EWMA de consistencia (α = 2 / (W + 1)). */
  CONSISTENCY_WINDOW: 14,
  /** Días máximos reconciliables de una sola pasada (protección ante relojes corruptos). */
  MAX_RECONCILE_DAYS: 400,
});

/** Preferencias por defecto (`system_metadata.user_preferences`). */
export const DEFAULT_PREFERENCES = deepFreeze({
  hapticsEnabled: true,
  wakeLockEnabled: false,
  theme: 'system', // 'system' | 'light' | 'dark'
  reducedMotion: false,
  lastSeenVersion: DB_VERSION,
});

/** Estado inicial de racha. */
export const INITIAL_STREAK_STATE = deepFreeze({
  currentStreak: 0,
  bestStreak: 0,
  shieldsAvailable: 0,
  shieldsUsedTotal: 0,
  weightedConsistencyScore: 0,
  lastEvaluatedDate: null,
});

/* ------------------------------------------------------------------ *
 * UI / interacción
 * ------------------------------------------------------------------ */

export const GESTURE_CONFIG = deepFreeze({
  /** Desplazamiento en px a partir del cual el gesto deja de ser un tap. */
  TAP_SLOP: 8,
  /** Desplazamiento horizontal mínimo para entrar en estado PANNING. */
  PAN_THRESHOLD: 12,
  /** Fracción del ancho del elemento que confirma la acción (umbral de disparo). */
  COMMIT_RATIO: 0.35,
  /** Velocidad (px/ms) que confirma el swipe aunque no se alcance COMMIT_RATIO. */
  FLING_VELOCITY: 0.45,
  /** A partir de esta fracción del ancho, el arrastre entra en fricción logarítmica. */
  FRICTION_RATIO: 0.5,
  /** Coeficiente k de la fricción: dx' = límite + k·ln(1 + exceso/k). */
  FRICTION_COEFFICIENT: 48,
  /** Duración de la animación de retorno/salida (ms). */
  SETTLE_MS: 180,
});

/** Parámetros de la hoja deslizante inferior. */
export const SHEET_CONFIG = deepFreeze({
  /** Fracción de la altura de la hoja que confirma el cierre por arrastre. */
  DISMISS_RATIO: 0.3,
  /** Velocidad (px/ms) que cierra la hoja aunque no se alcance DISMISS_RATIO. */
  DISMISS_VELOCITY: 0.5,
  /** Recorrido mínimo para que un gesto rápido cuente como cierre. */
  DISMISS_MIN_PX: 24,
  /** Resistencia al arrastrar hacia arriba (la hoja no sube). */
  UPWARD_RESISTANCE: 0.12,
  /** Duración de entrada/salida, sincronizada con el CSS. */
  TRANSITION_MS: 260,
});

/** Patrones de vibración (Vibration API). @enum {Array<number>|number} */
export const HAPTIC_PATTERNS = deepFreeze({
  TAP: 10,
  COMPLETE: [12, 40, 22],
  UNDO: 8,
  SKIP: [8, 30, 8],
  STREAK_UP: [18, 60, 18, 60, 36],
  ERROR: [40, 60, 40],
});

/** Eventos del bus de aplicación. @enum {string} */
export const EVENTS = deepFreeze({
  READY: 'app:ready',
  STATE_CHANGED: 'state:changed',
  TASK_TOGGLED: 'task:toggled',
  TASK_SKIPPED: 'task:skipped',
  TASK_SAVED: 'task:saved',
  TASK_ARCHIVED: 'task:archived',
  TASKS_REORDERED: 'tasks:reordered',
  DAY_ROLLED: 'day:rolled',
  STREAK_UPDATED: 'streak:updated',
  SHIELD_CONSUMED: 'streak:shield-consumed',
  TOAST: 'ui:toast',
  ERROR: 'app:error',
  SECTION_TOGGLED: 'ui:section-toggled',
  CLOCK_DESYNC: 'app:clock-desync',
});

/** Máximos de validación del modelo de datos. */
export const LIMITS = deepFreeze({
  TASK_TITLE_MAX: 80,
  /** Tope de un archivo de backup al importar: evita colgar el hilo en `JSON.parse`. */
  BACKUP_MAX_BYTES: 10 * 1024 * 1024,
  TASK_MINUTES_MAX: 24 * 60,
  HEATMAP_WEEKS: 20,
  /**
   * Objetivo táctil mínimo en px. 48 es la recomendación de las WCAG 2.2
   * (criterio 2.5.8, nivel AA) y de Material: por debajo, el índice de error
   * al tocar con el pulgar crece de forma marcada.
   */
  TAP_TARGET_MIN: 48,
});
