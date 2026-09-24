/**
 * @module domain/timeBlockService
 * Motor de bloques horarios condicionales por día de la semana.
 *
 * La rutina deja de ser «mañana / tarde / noche» para convertirse en la
 * agenda real: los bloques existen o no según el día (`dayOfWeek` en la
 * numeración de `Date.prototype.getDay()`: 0 = domingo … 6 = sábado) y tienen
 * un horario que también puede depender del día.
 *
 * ## Modelo
 *
 * Cada bloque declara una lista de **reglas**; cada regla dice en qué días
 * aplica y con qué horario. Un bloque sin regla para el día simplemente no
 * existe ese día, y sus tareas no se renderizan ni cuentan para la racha.
 *
 *     evening: [ { days: [1,3,4], start: '17:00', end: '23:00' },   // L, X, J
 *                { days: [2],     start: '20:30', end: '23:00' } ]  // M, tras clase
 *
 * ## Bloque activo: gana el más estrecho
 *
 * Los rangos pueden solaparse a propósito. El viernes, `night_weekend_prep`
 * cubre de 21:30 a 00:00 y `wind_down` de 23:00 a 00:00; a las 23:30 los dos
 * contienen el instante. El bloque activo es el de **menor duración**, porque
 * es el más específico: a las 23:30 de un viernes la app está en la rutina de
 * sueño, aunque también sea «cierre de semana». Con esta regla no hace falta
 * recortar rangos ni declarar prioridades a mano.
 */

import {
  minutesOfDay, normalizeRange, parseTime, formatMinutes, dayOfWeek, fromDateKey,
} from '../core/dateUtils.js';
import { deepFreeze } from '../security/objectGuard.js';

/** Todos los días de la semana, en la numeración de `getDay()`. */
const EVERY_DAY = Object.freeze([0, 1, 2, 3, 4, 5, 6]);
const WEEKDAYS = Object.freeze([1, 2, 3, 4, 5]);

/**
 * @typedef {Object} BlockRule
 * @property {number[]} days  Días en los que el bloque existe.
 * @property {string} [start] "HH:mm"; ausente en bloques sin horario fijo.
 * @property {string} [end]   "HH:mm".
 */

/**
 * @typedef {Object} BlockDefinition
 * @property {string} id
 * @property {string} label
 * @property {string} icon
 * @property {boolean} isAnchor  Bloque rígido (trabajo, clase, traslado).
 * @property {BlockRule[]} rules
 */

/**
 * @typedef {Object} ResolvedBlock
 * @property {string} id
 * @property {string} label
 * @property {string} icon
 * @property {boolean} isAnchor
 * @property {boolean} isTimed       `false` para el cajón sin horario.
 * @property {number|null} start     Minutos desde medianoche.
 * @property {number|null} end       Minutos desde medianoche (1440 = medianoche siguiente).
 * @property {string} range          Texto legible, p. ej. "09:00 – 14:00".
 */

/** Catálogo de bloques. Es la agenda declarada, no una preferencia de UI. */
export const BLOCK_CATALOG = deepFreeze({
  dawn: {
    id: 'dawn', label: 'Arranque', icon: '🌅', isAnchor: false,
    rules: [{ days: WEEKDAYS, start: '04:30', end: '08:30' }],
  },
  work_morning: {
    id: 'work_morning', label: 'Jornada · mañana', icon: '💼', isAnchor: true,
    rules: [{ days: WEEKDAYS, start: '09:00', end: '14:00' }],
  },
  lunch: {
    id: 'lunch', label: 'Comida', icon: '🍽️', isAnchor: false,
    rules: [{ days: WEEKDAYS, start: '14:00', end: '15:00' }],
  },
  work_afternoon: {
    id: 'work_afternoon', label: 'Jornada · tarde', icon: '💼', isAnchor: true,
    rules: [{ days: WEEKDAYS, start: '15:00', end: '17:00' }],
  },
  didi_shift: {
    id: 'didi_shift', label: 'Turno DiDi', icon: '🚗', isAnchor: true,
    rules: [{ days: [2], start: '17:00', end: '18:00' }],
  },
  commute_home: {
    id: 'commute_home', label: 'Traslado a casa', icon: '🏠', isAnchor: true,
    rules: [{ days: [2], start: '18:00', end: '19:00' }],
  },
  class_tuesday: {
    id: 'class_tuesday', label: 'Clase', icon: '🎓', isAnchor: true,
    rules: [{ days: [2], start: '19:00', end: '20:30' }],
  },
  commute_school: {
    id: 'commute_school', label: 'Traslado a la escuela', icon: '🚌', isAnchor: true,
    rules: [{ days: [5], start: '17:00', end: '18:30' }],
  },
  class_friday: {
    id: 'class_friday', label: 'Clase', icon: '🎓', isAnchor: true,
    rules: [{ days: [5], start: '18:30', end: '20:30' }],
  },
  commute_home_fri: {
    id: 'commute_home_fri', label: 'Traslado a casa', icon: '🏠', isAnchor: true,
    rules: [{ days: [5], start: '20:30', end: '21:30' }],
  },
  evening: {
    id: 'evening', label: 'Tiempo personal', icon: '🌙', isAnchor: false,
    rules: [
      { days: [1, 3, 4], start: '17:00', end: '23:00' },
      // El martes la tarde libre empieza al salir de clase.
      { days: [2], start: '20:30', end: '23:00' },
    ],
  },
  night_weekend_prep: {
    id: 'night_weekend_prep', label: 'Cierre de semana', icon: '🎉', isAnchor: false,
    rules: [{ days: [5], start: '21:30', end: '00:00' }],
  },
  wind_down: {
    id: 'wind_down', label: 'Desconexión', icon: '😴', isAnchor: false,
    rules: [{ days: EVERY_DAY, start: '23:00', end: '00:00' }],
  },
  weekend_morning: {
    id: 'weekend_morning', label: 'Mañana de fin de semana', icon: '☀️', isAnchor: false,
    rules: [
      { days: [6], start: '05:00', end: '12:00' },
      { days: [0], start: '06:00', end: '12:00' },
    ],
  },
  weekend_afternoon: {
    id: 'weekend_afternoon', label: 'Tarde libre', icon: '🛠️', isAnchor: false,
    rules: [{ days: [6, 0], start: '12:00', end: '19:00' }],
  },
  weekend_night: {
    id: 'weekend_night', label: 'Noche de fin de semana', icon: '🌆', isAnchor: false,
    rules: [{ days: [6, 0], start: '19:00', end: '00:00' }],
  },
  // Cajón sin horario: destino de la migración desde los bloques genéricos y
  // hogar de las tareas que no encajan en la agenda fija.
  anytime: {
    id: 'anytime', label: 'Cualquier momento', icon: '🕒', isAnchor: false,
    rules: [{ days: EVERY_DAY }],
  },
});

/** @type {ReadonlyArray<string>} */
export const BLOCK_IDS = Object.freeze(Object.keys(BLOCK_CATALOG));

/** Identificador del cajón sin horario. */
export const FALLBACK_BLOCK_ID = 'anytime';

/** Nombres cortos de los días, en la numeración de `getDay()`. */
export const DAY_LABELS = Object.freeze(['D', 'L', 'M', 'X', 'J', 'V', 'S']);
export const DAY_NAMES = Object.freeze([
  'domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado',
]);

/**
 * @param {string} id
 * @returns {BlockDefinition|null}
 */
export function getBlock(id) {
  return BLOCK_CATALOG[id] ?? null;
}

/** @param {string} id */
export function isBlockId(id) {
  return typeof id === 'string' && Object.hasOwn(BLOCK_CATALOG, id);
}

/**
 * Regla aplicable a un bloque en un día concreto.
 * @param {string} blockId
 * @param {number} day  0 = domingo … 6 = sábado.
 * @returns {BlockRule|null}
 */
export function ruleFor(blockId, day) {
  const block = BLOCK_CATALOG[blockId];
  if (!block) return null;
  return block.rules.find((rule) => rule.days.includes(day)) ?? null;
}

/**
 * Agenda completa de un día, ordenada por hora de inicio. Los bloques sin
 * horario van al final.
 * @param {string|Date} [date] clave `YYYY-MM-DD` o fecha.
 * @returns {ResolvedBlock[]}
 */
export function resolveSchedule(date = new Date()) {
  const day = dayOfWeek(date);
  /** @type {ResolvedBlock[]} */
  const blocks = [];

  for (const block of Object.values(BLOCK_CATALOG)) {
    const rule = ruleFor(block.id, day);
    if (!rule) continue;

    const timed = Boolean(rule.start && rule.end);
    const range = timed ? normalizeRange(rule.start, rule.end) : null;
    blocks.push({
      id: block.id,
      label: block.label,
      icon: block.icon,
      isAnchor: block.isAnchor,
      isTimed: timed,
      start: range ? range.start : null,
      end: range ? range.end : null,
      range: timed ? `${rule.start} – ${formatMinutes(range.end)}` : 'Sin horario fijo',
    });
  }

  return blocks.sort((a, b) => {
    if (a.isTimed !== b.isTimed) return a.isTimed ? -1 : 1;
    if (!a.isTimed) return a.label.localeCompare(b.label, 'es');
    if (a.start !== b.start) return a.start - b.start;
    return (a.end - a.start) - (b.end - b.start);
  });
}

/**
 * Bloque en curso ahora mismo: el más estrecho que contiene el instante.
 * @param {Date} [now]
 * @param {ResolvedBlock[]} [schedule] agenda ya resuelta (evita recalcularla).
 * @returns {ResolvedBlock|null}
 */
export function activeBlock(now = new Date(), schedule = resolveSchedule(now)) {
  const minute = minutesOfDay(now);
  let winner = null;
  for (const block of schedule) {
    if (!block.isTimed) continue;
    if (minute < block.start || minute >= block.end) continue;
    if (winner === null
      || (block.end - block.start) < (winner.end - winner.start)
      || ((block.end - block.start) === (winner.end - winner.start) && block.start > winner.start)) {
      winner = block;
    }
  }
  return winner;
}

/**
 * @param {Date} [now]
 * @param {ResolvedBlock[]} [schedule]
 * @returns {string|null}
 */
export function activeBlockId(now = new Date(), schedule = resolveSchedule(now)) {
  return activeBlock(now, schedule)?.id ?? null;
}

/**
 * Avance dentro de un bloque, para la barra de progreso del bloque en curso.
 * @param {ResolvedBlock} block
 * @param {Date} [now]
 * @returns {number} 0 … 1
 */
export function blockProgress(block, now = new Date()) {
  if (!block?.isTimed) return 0;
  const span = block.end - block.start;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (minutesOfDay(now) - block.start) / span));
}

/**
 * Instante en que cambia el bloque activo: el siguiente borde de bloque del
 * día, o la medianoche si ya no quedan.
 * @param {Date} [now]
 * @param {ResolvedBlock[]} [schedule]
 * @returns {number} minutos desde medianoche (1440 = medianoche siguiente).
 */
export function nextBoundaryMinute(now = new Date(), schedule = resolveSchedule(now)) {
  const minute = minutesOfDay(now);
  const edges = schedule
    .filter((block) => block.isTimed)
    .flatMap((block) => [block.start, block.end])
    .filter((edge) => edge > minute);
  return edges.length === 0 ? 1440 : Math.min(...edges);
}

/**
 * ¿La tarea aplica en esta fecha?
 *
 * Dos condiciones, ambas necesarias:
 *   1. `daysOfWeek` incluye el día (vacío = todos los días).
 *   2. Su bloque existe ese día.
 *
 * La segunda evita el caso incoherente: una tarea marcada «todos los días» en
 * un bloque que sólo existe los martes no puede aparecer un jueves.
 *
 * @param {{sectionId: string, daysOfWeek?: number[], isArchived?: boolean}} task
 * @param {string|Date} [date]
 * @returns {boolean}
 */
export function isTaskActiveOn(task, date = new Date()) {
  if (!task || task.isArchived) return false;
  const day = dayOfWeek(date);
  const days = Array.isArray(task.daysOfWeek) ? task.daysOfWeek : [];
  if (days.length > 0 && !days.includes(day)) return false;
  return ruleFor(task.sectionId, day) !== null;
}

/**
 * @param {Array<*>} tasks
 * @param {string|Date} [date]
 * @returns {Array<*>} sólo las tareas aplicables ese día.
 */
export function tasksForDay(tasks, date = new Date()) {
  return (tasks ?? []).filter((task) => isTaskActiveOn(task, date));
}

/**
 * Divisor del día: número de tareas aplicables. Es lo que hace que un lunes
 * sin clase no penalice por no haber ido a clase.
 * @param {Array<*>} tasks
 * @param {string|Date} [date]
 * @returns {number}
 */
export function countTasksForDay(tasks, date = new Date()) {
  return tasksForDay(tasks, date).length;
}

/**
 * Resumen legible de los días de una tarea.
 * @param {number[]} daysOfWeek
 * @returns {string}
 */
export function describeDays(daysOfWeek) {
  const days = Array.isArray(daysOfWeek) ? [...new Set(daysOfWeek)].sort() : [];
  if (days.length === 0 || days.length === 7) return 'Todos los días';
  if (days.length === 5 && [1, 2, 3, 4, 5].every((day) => days.includes(day))) return 'Entre semana';
  if (days.length === 2 && days.includes(0) && days.includes(6)) return 'Fines de semana';
  if (days.length === 1) return `Sólo ${DAY_NAMES[days[0]]}`;
  return days.map((day) => DAY_LABELS[day]).join(' · ');
}

/**
 * Vigila el cambio de bloque activo sin recargar la página.
 *
 * Programa un temporizador al **siguiente borde de bloque** en vez de sondear
 * cada pocos segundos, y añade un tick de seguridad porque los temporizadores
 * se congelan con la pestaña en segundo plano o el dispositivo suspendido.
 */
export class TimeBlockWatcher {
  /**
   * @param {{
   *   onChange: (context: {blockId: string|null, schedule: ResolvedBlock[], date: Date}) => void,
   *   now?: () => Date,
   *   safetyTickMs?: number,
   * }} options
   */
  constructor({ onChange, now = () => new Date(), safetyTickMs = 60_000 }) {
    this._onChange = onChange;
    this._now = now;
    this._safetyTickMs = safetyTickMs;
    this._timerId = null;
    this._tickId = null;
    this._listeners = [];
    this._running = false;
    /** @type {string|null|undefined} `undefined` = aún no evaluado. */
    this._lastBlockId = undefined;
    this._lastDayKey = null;
  }

  start() {
    if (this._running) return;
    this._running = true;

    if (typeof document !== 'undefined') {
      const handler = () => {
        if (document.visibilityState === 'visible') this.check();
      };
      document.addEventListener('visibilitychange', handler);
      this._listeners.push(() => document.removeEventListener('visibilitychange', handler));
    }
    if (typeof window !== 'undefined') {
      const handler = () => this.check();
      window.addEventListener('focus', handler);
      this._listeners.push(() => window.removeEventListener('focus', handler));
    }

    this._tickId = setInterval(() => this.check(), this._safetyTickMs);
    this.check();
  }

  stop() {
    this._running = false;
    if (this._timerId !== null) clearTimeout(this._timerId);
    if (this._tickId !== null) clearInterval(this._tickId);
    this._timerId = null;
    this._tickId = null;
    for (const dispose of this._listeners.splice(0)) dispose();
  }

  /**
   * Evalúa el bloque activo y notifica si cambió.
   * @returns {string|null} el bloque activo.
   */
  check() {
    const now = this._now();
    const schedule = resolveSchedule(now);
    const blockId = activeBlockId(now, schedule);
    const dayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;

    if (blockId !== this._lastBlockId || dayKey !== this._lastDayKey) {
      this._lastBlockId = blockId;
      this._lastDayKey = dayKey;
      try {
        this._onChange({ blockId, schedule, date: now });
      } catch (error) {
        console.error('[TimeBlockWatcher] onChange falló', error);
      }
    }
    this._schedule(now, schedule);
    return blockId;
  }

  /** @param {Date} now @param {ResolvedBlock[]} schedule */
  _schedule(now, schedule) {
    if (!this._running) return;
    if (this._timerId !== null) clearTimeout(this._timerId);
    const boundary = nextBoundaryMinute(now, schedule);
    const msUntil = (boundary - minutesOfDay(now)) * 60_000 - now.getSeconds() * 1000 + 500;
    this._timerId = setTimeout(() => this.check(), Math.max(1000, msUntil));
  }
}

export { fromDateKey };
