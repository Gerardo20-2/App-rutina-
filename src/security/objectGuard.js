/**
 * @module security/objectGuard
 * Defensa contra prototype pollution en la frontera de datos no confiables.
 *
 * `JSON.parse` crea `__proto__` como propiedad propia inofensiva, pero en
 * cuanto ese objeto pasa por un `Object.assign`, un spread o una fusión
 * profunda, la clave reescribe el prototipo del destino. Todo JSON que entra
 * desde fuera (un backup importado, `localStorage` manipulado) se parsea aquí.
 */

/** Claves que nunca se aceptan en datos externos. */
export const FORBIDDEN_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

const FORBIDDEN = new Set(FORBIDDEN_KEYS);

/** @param {string} key */
export function isForbiddenKey(key) {
  return FORBIDDEN.has(key);
}

/**
 * `JSON.parse` que descarta en cualquier nivel las claves peligrosas.
 * @param {string} text
 * @returns {*}
 * @throws {SyntaxError} si el texto no es JSON.
 */
export function safeJsonParse(text) {
  return JSON.parse(text, (key, value) => (FORBIDDEN.has(key) ? undefined : value));
}

/**
 * Copia profunda de datos JSON-compatibles en objetos sin claves peligrosas.
 * Funciones, símbolos y ciclos no son datos: se descartan.
 * @param {*} value
 * @param {WeakSet<object>} [seen]
 * @returns {*}
 */
export function sanitizeDeep(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' || typeof value === 'symbol' ? undefined : value;
  }
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeDeep(item, seen));
  /** @type {Object.<string, *>} */
  const out = {};
  for (const key of Object.keys(value)) {
    if (FORBIDDEN.has(key)) continue;
    const clean = sanitizeDeep(value[key], seen);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

/**
 * `Object.freeze` recursivo para catálogos y configuraciones globales. Recorre
 * también los hijos de objetos ya congelados: un `Object.freeze` superficial
 * deja mutables las reglas anidadas.
 * @template T
 * @param {T} value
 * @param {WeakSet<object>} [seen]
 * @returns {Readonly<T>}
 */
export function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}
