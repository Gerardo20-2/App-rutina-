/**
 * @module storage/storageAdapter
 * Interfaz base de persistencia. Define el contrato que implementan
 * `indexedDbService` (primario) y `localStorageService` (respaldo), de modo
 * que el resto de la aplicación nunca conoce el motor subyacente.
 *
 * Contrato: todos los métodos devuelven promesas; las claves son strings;
 * los valores deben ser estructuras clonables (structured clone).
 */

/** Error uniforme de la capa de almacenamiento. */
export class StorageError extends Error {
  /**
   * @param {string} message
   * @param {{cause?: unknown, code?: string}} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'StorageError';
    this.code = options.code ?? 'STORAGE_ERROR';
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * @abstract
 */
export class StorageAdapter {
  /** @returns {string} identificador del motor: 'indexeddb' | 'localstorage' | 'memory'. */
  get engine() {
    return 'abstract';
  }

  /**
   * ¿El motor está disponible en este entorno? (modo privado, SSR, etc.)
   * @returns {Promise<boolean>}
   */
  static async isSupported() {
    return false;
  }

  /** Abre/prepara el almacenamiento. Idempotente. @returns {Promise<void>} */
  async init() {
    throw new StorageError('init() no implementado', { code: 'NOT_IMPLEMENTED' });
  }

  /**
   * @param {string} store
   * @param {string} key
   * @returns {Promise<*|undefined>}
   */
  async get(store, key) { // eslint-disable-line no-unused-vars
    throw new StorageError('get() no implementado', { code: 'NOT_IMPLEMENTED' });
  }

  /**
   * @param {string} store
   * @param {{index?: string, range?: {lower?: *, upper?: *}, limit?: number}} [query]
   * @returns {Promise<Array<*>>}
   */
  async getAll(store, query) { // eslint-disable-line no-unused-vars
    throw new StorageError('getAll() no implementado', { code: 'NOT_IMPLEMENTED' });
  }

  /**
   * @param {string} store
   * @param {*} value
   * @returns {Promise<*>} el valor escrito.
   */
  async put(store, value) { // eslint-disable-line no-unused-vars
    throw new StorageError('put() no implementado', { code: 'NOT_IMPLEMENTED' });
  }

  /**
   * Escritura atómica de varios registros en un mismo store.
   * @param {string} store
   * @param {Array<*>} values
   * @returns {Promise<void>}
   */
  async bulkPut(store, values) { // eslint-disable-line no-unused-vars
    throw new StorageError('bulkPut() no implementado', { code: 'NOT_IMPLEMENTED' });
  }

  /**
   * @param {string} store
   * @param {string} key
   * @returns {Promise<void>}
   */
  async delete(store, key) { // eslint-disable-line no-unused-vars
    throw new StorageError('delete() no implementado', { code: 'NOT_IMPLEMENTED' });
  }

  /**
   * @param {string} store
   * @returns {Promise<void>}
   */
  async clear(store) { // eslint-disable-line no-unused-vars
    throw new StorageError('clear() no implementado', { code: 'NOT_IMPLEMENTED' });
  }

  /**
   * Volcado completo para copia de seguridad / migración.
   * @returns {Promise<{version:number, exportedAt:string, data:Object.<string, Array<*>>}>}
   */
  async exportAll() {
    throw new StorageError('exportAll() no implementado', { code: 'NOT_IMPLEMENTED' });
  }

  /**
   * Restaura un volcado. Reemplaza el contenido de los stores presentes.
   * @param {{version:number, data:Object.<string, Array<*>>}} dump
   * @returns {Promise<void>}
   */
  async importAll(dump) { // eslint-disable-line no-unused-vars
    throw new StorageError('importAll() no implementado', { code: 'NOT_IMPLEMENTED' });
  }

  /**
   * ¿Puede guardar objetos `CryptoKey` con la misma vida que los datos? Sin
   * esa garantía la integridad HMAC se desactiva: una clave que se pierde al
   * recargar convertiría cada registro legítimo en «manipulado».
   * @returns {boolean}
   */
  get supportsSecrets() {
    return false;
  }

  /** @param {string} name @returns {Promise<CryptoKey|undefined>} */
  async getSecret(name) { // eslint-disable-line no-unused-vars
    throw new StorageError('getSecret() no implementado', { code: 'NOT_IMPLEMENTED' });
  }

  /** @param {string} name @param {CryptoKey} key @returns {Promise<void>} */
  async putSecret(name, key) { // eslint-disable-line no-unused-vars
    throw new StorageError('putSecret() no implementado', { code: 'NOT_IMPLEMENTED' });
  }

  /** Cierra recursos abiertos. @returns {Promise<void>} */
  async close() {}
}
