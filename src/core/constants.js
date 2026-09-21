/**
 * @module core/constants
 * Configuración base, claves de persistencia y enumeraciones del dominio.
 * Todo valor "mágico" del sistema vive aquí: ningún otro módulo debe declarar
 * literales de configuración.
 */

/* ------------------------------------------------------------------ *
 * Persistencia
 * ------------------------------------------------------------------ */

/** @type {string} Nombre de la base IndexedDB. */
export const DB_NAME = 'routine_tracker_db';

/** @type {number} Versión del esquema IndexedDB (v2 = tasks + daily_logs + system_metadata). */
export const DB_VERSION = 2;

/** Nombres de object stores. @enum {string} */
export const STORES = Object.freeze({
  TASKS: 'tasks',
  DAILY_LOGS: 'daily_logs',
  SYSTEM_METADATA: 'system_metadata',
  /** Store legado de la v1, se lee sólo durante la migración. */
  LEGACY_APP_STATE: 'app_state',
});

/** Índices declarados por store. @enum {Object.<string,string>} */
export const INDICES = Object.freeze({
  [STORES.TASKS]: Object.freeze({
    idx_section: 'section',
    idx_order: 'order',
    idx_archived: 'isArchived',
  }),
  [STORES.DAILY_LOGS]: Object.freeze({
    idx_completion_rate: 'completionRate',
  }),
});

/** Claves obligatorias del store `system_metadata`. @enum {string} */
export const META_KEYS = Object.freeze({
  STREAK_STATE: 'streak_state',
  USER_PREFERENCES: 'user_preferences',
  SCHEMA_VERSION: 'schema_version',
});

/** Claves usadas en `localStorage` (fallback y migración desde la v1). @enum {string} */
export const LS_KEYS = Object.freeze({
  /** Estado monolítico de la arquitectura v1. */
  LEGACY_APP_STATE: 'APP_STATE_V1',
  /** Prefijo del adaptador de respaldo `localStorageService`. */
  NAMESPACE: 'routine_tracker_v2',
});

/** Identificador del caché del Service Worker (sincronizado manualmente con `public/sw.js`). */
export const CACHE_NAME = 'routine-tracker-v2';

/* ------------------------------------------------------------------ *
 * Dominio
 * ------------------------------------------------------------------ */

/** Bloques del día. @enum {string} */
export const SECTIONS = Object.freeze({
  MORNING: 'morning',
  AFTERNOON: 'afternoon',
  EVENING: 'evening',
  ANYTIME: 'anytime',
});

/** @type {ReadonlyArray<string>} Orden canónico de render de los bloques. */
export const SECTION_ORDER = Object.freeze([
  SECTIONS.MORNING,
  SECTIONS.AFTERNOON,
  SECTIONS.EVENING,
  SECTIONS.ANYTIME,
]);

/** Metadatos de presentación por bloque. */
export const SECTION_META = Object.freeze({
  [SECTIONS.MORNING]: { label: 'Mañana', icon: '☀️', range: '05:00 – 12:00' },
  [SECTIONS.AFTERNOON]: { label: 'Tarde', icon: '🌤️', range: '12:00 – 19:00' },
  [SECTIONS.EVENING]: { label: 'Noche', icon: '🌙', range: '19:00 – 00:00' },
  [SECTIONS.ANYTIME]: { label: 'Cualquier momento', icon: '🕒', range: 'Libre' },
});

/** Resultado de la evaluación de un día cerrado. @enum {string} */
export const DAY_OUTCOME = Object.freeze({
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
export const STREAK_TRANSITION = Object.freeze({
  EXTENDED: 'EXTENDED',
  PRESERVED_PARTIAL: 'PRESERVED_PARTIAL',
  PRESERVED_BY_SHIELD: 'PRESERVED_BY_SHIELD',
  BROKEN: 'BROKEN',
  SKIPPED_VOID: 'SKIPPED_VOID',
});

/** Estados del `dayResetService`. @enum {string} */
export const RESET_STATE = Object.freeze({
  IDLE: 'IDLE',
  SCHEDULED: 'SCHEDULED',
  EVALUATING: 'EVALUATING',
  RECONCILING: 'RECONCILING',
  ERROR: 'ERROR',
});

/* ------------------------------------------------------------------ *
 * Parámetros del algoritmo de racha resiliente
 * ------------------------------------------------------------------ */

export const STREAK_CONFIG = Object.freeze({
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
export const DEFAULT_PREFERENCES = Object.freeze({
  hapticsEnabled: true,
  wakeLockEnabled: false,
  theme: 'system', // 'system' | 'light' | 'dark'
  reducedMotion: false,
  lastSeenVersion: DB_VERSION,
});

/** Estado inicial de racha. */
export const INITIAL_STREAK_STATE = Object.freeze({
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

export const GESTURE_CONFIG = Object.freeze({
  /** Desplazamiento en px a partir del cual el gesto deja de ser un tap. */
  TAP_SLOP: 8,
  /** Desplazamiento horizontal mínimo para entrar en estado PANNING. */
  PAN_THRESHOLD: 12,
  /** Fracción del ancho del elemento necesaria para confirmar el swipe. */
  COMMIT_RATIO: 0.35,
  /** Velocidad (px/ms) que confirma el swipe aunque no se alcance COMMIT_RATIO. */
  FLING_VELOCITY: 0.45,
  /** Resistencia elástica más allá del umbral de confirmación. */
  RUBBER_BAND: 0.35,
  /** Duración de la animación de retorno/salida (ms). */
  SETTLE_MS: 180,
});

/** Patrones de vibración (Vibration API). @enum {Array<number>|number} */
export const HAPTIC_PATTERNS = Object.freeze({
  TAP: 10,
  COMPLETE: [12, 40, 22],
  UNDO: 8,
  SKIP: [8, 30, 8],
  STREAK_UP: [18, 60, 18, 60, 36],
  ERROR: [40, 60, 40],
});

/** Eventos del bus de aplicación. @enum {string} */
export const EVENTS = Object.freeze({
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
});

/** Máximos de validación del modelo de datos. */
export const LIMITS = Object.freeze({
  TASK_TITLE_MAX: 80,
  TASK_MINUTES_MAX: 24 * 60,
  HEATMAP_WEEKS: 20,
});
