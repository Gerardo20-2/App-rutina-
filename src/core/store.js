/**
 * @module core/store
 * Estado reactivo centralizado. El store es la **única** fuente de verdad en
 * memoria: la capa de almacenamiento lo hidrata y las acciones lo mutan
 * mediante reemplazo inmutable. El render nunca lee de IndexedDB.
 *
 * Las notificaciones se agrupan en un microtask: N mutaciones síncronas
 * producen un único ciclo de render.
 */

import { bus } from './events.js';
import { EVENTS, DEFAULT_PREFERENCES, INITIAL_STREAK_STATE } from './constants.js';
import { toDateKey } from './dateUtils.js';

/**
 * @typedef {Object} AppState
 * @property {boolean} ready            Hidratación completada.
 * @property {string} today             Clave `YYYY-MM-DD` del día activo.
 * @property {import('../domain/taskValidator.js').TaskDefinition[]} tasks Tareas activas ordenadas.
 * @property {import('../domain/taskValidator.js').DailyLog} log           Log del día activo.
 * @property {import('../domain/streakCalculator.js').StreakState} streak  Estado de racha.
 * @property {Object} preferences       Preferencias de usuario.
 * @property {Object.<string, {completionRate:number, completedCount:number, totalActiveTasks:number}>} history Resumen para el heatmap.
 * @property {{
 *   busy: boolean,
 *   persistence: 'indexeddb'|'localstorage'|'memory',
 *   collapsedSections: string[],
 *   clockDesynced: boolean,
 * }} ui
 */

/** @returns {AppState} */
export function createInitialState() {
  const today = toDateKey();
  return {
    ready: false,
    today,
    tasks: [],
    log: {
      date: today,
      entries: {},
      totalActiveTasks: 0,
      completedCount: 0,
      completionRate: 0,
      closed: false,
    },
    streak: { ...INITIAL_STREAK_STATE },
    preferences: { ...DEFAULT_PREFERENCES },
    history: {},
    ui: {
      busy: false,
      persistence: 'memory',
      // Bloques del día plegados. Se calcula en la hidratación: abierto el de
      // la hora actual, plegados los demás.
      collapsedSections: [],
      // El reloj del dispositivo retrocedió respecto al último día evaluado:
      // el cálculo diario queda congelado hasta que vuelva a ser coherente.
      clockDesynced: false,
    },
  };
}

export class Store {
  /** @param {AppState} [initialState] */
  constructor(initialState = createInitialState()) {
    /** @type {AppState} */
    this._state = initialState;
    /** @type {Set<{selector: Function, listener: Function, equals: Function, last: *}>} */
    this._subscriptions = new Set();
    this._notifyScheduled = false;
    /** @type {AppState|null} Instantánea previa al lote pendiente. */
    this._pendingPrev = null;
  }

  /** @returns {AppState} */
  getState() {
    return this._state;
  }

  /**
   * Aplica un parche superficial o el resultado de un updater.
   * @param {Partial<AppState>|((state: AppState) => Partial<AppState>)} patch
   * @returns {AppState} el nuevo estado.
   */
  setState(patch) {
    const partial = typeof patch === 'function' ? patch(this._state) : patch;
    if (!partial || typeof partial !== 'object') return this._state;

    let changed = false;
    for (const key of Object.keys(partial)) {
      if (!Object.is(this._state[key], partial[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return this._state;

    if (this._pendingPrev === null) this._pendingPrev = this._state;
    this._state = { ...this._state, ...partial };
    this._scheduleNotify();
    return this._state;
  }

  /**
   * Parche anidado sobre una clave de primer nivel de tipo objeto.
   * @param {keyof AppState} key
   * @param {Object} patch
   */
  patch(key, patch) {
    const current = this._state[key];
    if (!current || typeof current !== 'object') {
      throw new TypeError(`Store.patch: "${String(key)}" no es un objeto`);
    }
    return this.setState({ [key]: { ...current, ...patch } });
  }

  /**
   * Suscribe a una porción derivada del estado.
   * @template T
   * @param {(state: AppState) => T} selector
   * @param {(value: T, state: AppState) => void} listener
   * @param {(a: T, b: T) => boolean} [equals] comparador (por defecto `Object.is`).
   * @returns {() => void} función de baja.
   */
  subscribe(selector, listener, equals = Object.is) {
    if (typeof selector !== 'function' || typeof listener !== 'function') {
      throw new TypeError('Store.subscribe: selector y listener deben ser funciones');
    }
    const entry = { selector, listener, equals, last: selector(this._state) };
    this._subscriptions.add(entry);
    return () => this._subscriptions.delete(entry);
  }

  /** Fuerza la entrega inmediata del lote pendiente (útil en tests). */
  flush() {
    if (!this._notifyScheduled) return;
    this._notifyScheduled = false;
    this._notify();
  }

  _scheduleNotify() {
    if (this._notifyScheduled) return;
    this._notifyScheduled = true;
    queueMicrotask(() => {
      if (!this._notifyScheduled) return;
      this._notifyScheduled = false;
      this._notify();
    });
  }

  _notify() {
    const state = this._state;
    const prev = this._pendingPrev ?? state;
    this._pendingPrev = null;

    for (const entry of [...this._subscriptions]) {
      let next;
      try {
        next = entry.selector(state);
      } catch (error) {
        console.error('[Store] selector falló', error);
        continue;
      }
      if (entry.equals(entry.last, next)) continue;
      entry.last = next;
      try {
        entry.listener(next, state);
      } catch (error) {
        console.error('[Store] listener falló', error);
      }
    }
    bus.emit(EVENTS.STATE_CHANGED, { state, prev });
  }
}

/** Comparación superficial, útil como `equals` de selectores que devuelven objetos. */
export function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.is(a[k], b[k]));
}

/** Store compartido por la aplicación. */
export const store = new Store();
