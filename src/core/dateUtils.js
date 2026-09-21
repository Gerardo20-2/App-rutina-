/**
 * @module core/dateUtils
 * Utilidades de fecha en **hora local**. Todas las claves de día usan el
 * formato `YYYY-MM-DD` derivado del calendario local del usuario: usar UTC
 * provocaría saltos de día en husos negativos (el corte de medianoche es un
 * evento local, no universal).
 */

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/**
 * @param {Date} [date]
 * @returns {string} clave `YYYY-MM-DD` en hora local.
 */
export function toDateKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new RangeError('toDateKey: fecha inválida');
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * @param {string} key clave `YYYY-MM-DD`.
 * @returns {Date} medianoche local del día indicado.
 */
export function fromDateKey(key) {
  assertDateKey(key);
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d, 0, 0, 0, 0);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
    throw new RangeError(`fromDateKey: fecha inexistente "${key}"`);
  }
  return date;
}

/** @param {string} key */
export function isDateKey(key) {
  if (typeof key !== 'string' || !DATE_KEY_RE.test(key)) return false;
  try {
    fromDateKey(key);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} key */
export function assertDateKey(key) {
  if (typeof key !== 'string' || !DATE_KEY_RE.test(key)) {
    throw new TypeError(`Clave de fecha inválida: ${JSON.stringify(key)} (se esperaba YYYY-MM-DD)`);
  }
}

/**
 * Suma días de calendario (seguro ante DST: opera sobre componentes locales).
 * @param {string} key
 * @param {number} days
 * @returns {string}
 */
export function addDays(key, days) {
  const date = fromDateKey(key);
  date.setDate(date.getDate() + Math.trunc(days));
  return toDateKey(date);
}

/**
 * Diferencia en días de calendario (`b - a`). Normaliza a mediodía local para
 * que los cambios de horario de verano (±1h) no alteren el cociente.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function diffDays(a, b) {
  const da = fromDateKey(a);
  const db = fromDateKey(b);
  da.setHours(12, 0, 0, 0);
  db.setHours(12, 0, 0, 0);
  return Math.round((db.getTime() - da.getTime()) / MS_PER_DAY);
}

/**
 * Rango inclusivo de claves de día.
 * @param {string} from
 * @param {string} to
 * @returns {string[]}
 */
export function rangeDays(from, to) {
  const span = diffDays(from, to);
  if (span < 0) return [];
  const out = new Array(span + 1);
  let cursor = from;
  for (let i = 0; i <= span; i += 1) {
    out[i] = cursor;
    cursor = addDays(cursor, 1);
  }
  return out;
}

/**
 * Milisegundos hasta la próxima medianoche local.
 * @param {Date} [now]
 * @returns {number} siempre > 0.
 */
export function msUntilNextMidnight(now = new Date()) {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 50);
  return Math.max(1, next.getTime() - now.getTime());
}

/**
 * Minutos transcurridos desde la medianoche local.
 * @param {Date} [now]
 * @returns {number} 0 … 1439
 */
export function minutesOfDay(now = new Date()) {
  return now.getHours() * 60 + now.getMinutes();
}

/**
 * Convierte "HH:mm" en minutos desde medianoche.
 * @param {string} time
 * @returns {number} 0 … 1440 ("24:00" y "00:00" como fin valen 1440 vía {@link normalizeRange}).
 * @throws {TypeError} si el formato no es "HH:mm".
 */
export function parseTime(time) {
  if (typeof time !== 'string' || !/^([01]\d|2[0-4]):[0-5]\d$/.test(time)) {
    throw new TypeError(`Hora inválida: ${JSON.stringify(time)} (se esperaba HH:mm)`);
  }
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/** @param {string} time @returns {boolean} */
export function isTime(time) {
  try {
    parseTime(time);
    return true;
  } catch {
    return false;
  }
}

/**
 * Minutos desde medianoche a "HH:mm" (1440 se muestra como "24:00").
 * @param {number} minutes
 * @returns {string}
 */
export function formatMinutes(minutes) {
  const total = Math.max(0, Math.min(1440, Math.round(minutes)));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Normaliza un rango horario a minutos, tratando el fin "00:00" como el final
 * del día (1440) en lugar de como el principio: un bloque de 23:00 a 00:00
 * dura una hora, no menos veintitrés.
 * @param {string} start
 * @param {string} end
 * @returns {{start: number, end: number}}
 */
export function normalizeRange(start, end) {
  const from = parseTime(start);
  let to = parseTime(end);
  if (to <= from) to += 1440;
  return { start: from, end: Math.min(to, 1440 + from) };
}

/**
 * Día de la semana en la numeración de `Date.prototype.getDay()`.
 * @param {string|Date} value clave `YYYY-MM-DD` o fecha.
 * @returns {number} 0 = domingo … 6 = sábado.
 */
export function dayOfWeek(value = new Date()) {
  const date = typeof value === 'string' ? fromDateKey(value) : value;
  return date.getDay();
}

/**
 * Formato legible largo, con degradación si `Intl` no está disponible.
 * @param {string} key
 * @param {string} [locale]
 * @returns {string}
 */
export function formatLongDate(key, locale = 'es-ES') {
  const date = fromDateKey(key);
  try {
    return new Intl.DateTimeFormat(locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(date);
  } catch {
    return key;
  }
}

/**
 * Índice de día de la semana con lunes como 0, para la rejilla del heatmap
 * (no confundir con {@link dayOfWeek}, que usa la numeración de `getDay()`).
 * @param {string} key
 * @returns {number} 0 = lunes … 6 = domingo.
 */
export function weekdayIndex(key) {
  return (fromDateKey(key).getDay() + 6) % 7;
}

export { MS_PER_DAY };
