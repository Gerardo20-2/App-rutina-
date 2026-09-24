/**
 * @module storage/localStorageService
 * Implementación de respaldo de {@link StorageAdapter} sobre `localStorage`,
 * con serialización JSON e import/export.
 *
 * Se usa cuando IndexedDB no está disponible (Safari en modo privado, WebView
 * restringidas, políticas corporativas). Mantiene exactamente el mismo
 * contrato, de modo que el repositorio y el dominio no distinguen el motor.
 *
 * Si tampoco hay `localStorage`, la clase cae a un mapa en memoria: la app
 * sigue siendo usable durante la sesión aunque no persista (`engine` lo
 * reporta como `memory` para que la UI pueda avisar).
 */

import { StorageAdapter, StorageError } from './storageAdapter.js';
import { LS_KEYS, STORES } from '../core/constants.js';
import { safeJsonParse } from '../security/objectGuard.js';

/** Clave primaria de cada store, equivalente al `keyPath` de IndexedDB. */
const KEY_PATHS = Object.freeze({
  [STORES.TASKS]: 'id',
  [STORES.DAILY_LOGS]: 'date',
  [STORES.SYSTEM_METADATA]: 'key',
});

/** Mapa en memoria con la superficie de `Storage` que usamos. */
class MemoryBackend {
  constructor() { this._map = new Map(); }
  getItem(key) { return this._map.has(key) ? this._map.get(key) : null; }
  setItem(key, value) { this._map.set(key, String(value)); }
  removeItem(key) { this._map.delete(key); }
}

export class LocalStorageService extends StorageAdapter {
  /**
   * @param {{namespace?: string, backend?: Storage}} [options]
   */
  constructor(options = {}) {
    super();
    this._namespace = options.namespace ?? LS_KEYS.NAMESPACE;
    this._backend = options.backend ?? resolveBackend();
    this._isMemory = this._backend instanceof MemoryBackend;
    /** @type {Map<string, Object>} Caché de escritura para evitar parse repetido. */
    this._cache = new Map();
    /** @type {Map<string, CryptoKey>} */
    this._secrets = new Map();
  }

  /**
   * `localStorage` sólo guarda texto y una `CryptoKey` no exportable no se
   * puede serializar: los secretos sólo se ofrecen en modo memoria, donde
   * clave y datos mueren juntos.
   */
  get supportsSecrets() {
    return this._isMemory;
  }

  async getSecret(name) {
    return this._secrets.get(name);
  }

  async putSecret(name, key) {
    if (!this._isMemory) throw new StorageError('localStorage no puede guardar claves', { code: 'NO_SECRETS' });
    this._secrets.set(name, key);
  }

  get engine() {
    return this._isMemory ? 'memory' : 'localstorage';
  }

  static async isSupported() {
    return probeLocalStorage() !== null;
  }

  async init() {
    // No hay recursos que abrir; se valida que el backend responda.
    try {
      this._backend.getItem(`${this._namespace}:__probe__`);
    } catch (error) {
      throw new StorageError('localStorage inaccesible', { cause: error, code: 'OPEN_FAILED' });
    }
  }

  async get(store, key) {
    return this._read(store)[key];
  }

  async getAll(store, query = {}) {
    let values = Object.values(this._read(store));
    if (query.index || query.range) {
      const keyPath = indexKeyPath(store, query.index);
      const { lower, upper } = query.range ?? {};
      values = values
        .filter((value) => {
          const v = value?.[keyPath];
          if (lower !== undefined && v < lower) return false;
          if (upper !== undefined && v > upper) return false;
          return true;
        })
        .sort((a, b) => compare(a?.[keyPath], b?.[keyPath]));
    }
    return typeof query.limit === 'number' ? values.slice(0, query.limit) : values;
  }

  async put(store, value) {
    const keyPath = KEY_PATHS[store] ?? 'id';
    const key = value?.[keyPath];
    if (key === undefined || key === null) {
      throw new StorageError(`Registro sin clave primaria "${keyPath}"`, { code: 'NO_KEY' });
    }
    const data = this._read(store);
    data[String(key)] = value;
    this._write(store, data);
    return value;
  }

  async bulkPut(store, values) {
    if (!Array.isArray(values) || values.length === 0) return;
    const keyPath = KEY_PATHS[store] ?? 'id';
    const data = this._read(store);
    for (const value of values) {
      const key = value?.[keyPath];
      if (key === undefined || key === null) continue;
      data[String(key)] = value;
    }
    this._write(store, data);
  }

  async delete(store, key) {
    const data = this._read(store);
    delete data[String(key)];
    this._write(store, data);
  }

  async clear(store) {
    this._write(store, {});
  }

  async exportAll() {
    /** @type {Object.<string, Array<*>>} */
    const data = {};
    for (const store of Object.keys(KEY_PATHS)) {
      data[store] = Object.values(this._read(store));
    }
    return { version: 2, exportedAt: new Date().toISOString(), data };
  }

  async importAll(dump) {
    if (!dump || typeof dump !== 'object' || !dump.data) {
      throw new StorageError('Volcado inválido', { code: 'BAD_DUMP' });
    }
    for (const [store, values] of Object.entries(dump.data)) {
      if (!KEY_PATHS[store] || !Array.isArray(values)) continue;
      await this.clear(store);
      await this.bulkPut(store, values);
    }
  }

  /** @param {string} store @returns {Object.<string, *>} */
  _read(store) {
    if (this._cache.has(store)) return this._cache.get(store);
    let parsed = {};
    try {
      const raw = this._backend.getItem(this._key(store));
      if (raw) {
        const value = safeJsonParse(raw);
        if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value;
      }
    } catch (error) {
      // Dato corrupto: se descarta ese store en lugar de dejar la app inutilizable.
      console.warn(`[LocalStorageService] "${store}" corrupto, se reinicia`, error);
    }
    this._cache.set(store, parsed);
    return parsed;
  }

  _write(store, data) {
    this._cache.set(store, data);
    try {
      this._backend.setItem(this._key(store), JSON.stringify(data));
    } catch (error) {
      throw new StorageError('Cuota de localStorage agotada', { cause: error, code: 'QUOTA_EXCEEDED' });
    }
  }

  _key(store) {
    return `${this._namespace}:${store}`;
  }
}

/** @returns {Storage|MemoryBackend} */
function resolveBackend() {
  return probeLocalStorage() ?? new MemoryBackend();
}

/** @returns {Storage|null} */
function probeLocalStorage() {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return null;
    const probeKey = '__routine_tracker_probe__';
    ls.setItem(probeKey, '1');
    ls.removeItem(probeKey);
    return ls;
  } catch {
    return null;
  }
}

function indexKeyPath(store, index) {
  if (!index) return KEY_PATHS[store] ?? 'id';
  // Los índices se nombran `idx_<campo>`; `idx_completion_rate` → `completionRate`.
  const field = index.replace(/^idx_/, '');
  return field.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function compare(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export { MemoryBackend };
