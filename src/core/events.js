/**
 * @module core/events
 * EventBus pub/sub mínimo, sin dependencias, con aislamiento de errores:
 * un suscriptor que lanza nunca impide que el resto reciba el evento.
 */

/**
 * @template T
 * @callback Listener
 * @param {T} payload
 * @returns {void}
 */

export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._channels = new Map();
    /** @type {Set<Function>} */
    this._anyListeners = new Set();
  }

  /**
   * Suscribe un listener a un canal.
   * @param {string} type
   * @param {Listener<*>} listener
   * @returns {() => void} función de baja (idempotente).
   */
  on(type, listener) {
    assertListener(listener);
    let set = this._channels.get(type);
    if (!set) {
      set = new Set();
      this._channels.set(type, set);
    }
    set.add(listener);
    return () => this.off(type, listener);
  }

  /**
   * Suscribe un listener que se ejecuta una única vez.
   * @param {string} type
   * @param {Listener<*>} listener
   * @returns {() => void}
   */
  once(type, listener) {
    assertListener(listener);
    const wrapped = (payload) => {
      this.off(type, wrapped);
      listener(payload);
    };
    return this.on(type, wrapped);
  }

  /**
   * Observa todos los canales (útil para logging/devtools).
   * @param {(type: string, payload: *) => void} listener
   * @returns {() => void}
   */
  onAny(listener) {
    assertListener(listener);
    this._anyListeners.add(listener);
    return () => this._anyListeners.delete(listener);
  }

  /**
   * @param {string} type
   * @param {Listener<*>} listener
   */
  off(type, listener) {
    const set = this._channels.get(type);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) this._channels.delete(type);
  }

  /**
   * Emite de forma síncrona. Los errores se reportan por consola y no propagan.
   * @param {string} type
   * @param {*} [payload]
   */
  emit(type, payload) {
    const set = this._channels.get(type);
    if (set) {
      // Copia defensiva: un listener puede darse de baja durante la emisión.
      for (const listener of [...set]) {
        try {
          listener(payload);
        } catch (error) {
          console.error(`[EventBus] listener de "${type}" falló`, error);
        }
      }
    }
    for (const listener of [...this._anyListeners]) {
      try {
        listener(type, payload);
      } catch (error) {
        console.error('[EventBus] listener global falló', error);
      }
    }
  }

  /** Elimina todos los listeners (usado en tests y en teardown). */
  clear() {
    this._channels.clear();
    this._anyListeners.clear();
  }

  /**
   * @param {string} type
   * @returns {number} cantidad de suscriptores del canal.
   */
  listenerCount(type) {
    return this._channels.get(type)?.size ?? 0;
  }
}

function assertListener(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('EventBus: el listener debe ser una función');
  }
}

/** Bus compartido por la aplicación. */
export const bus = new EventBus();
