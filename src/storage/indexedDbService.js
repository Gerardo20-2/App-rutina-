/**
 * @module storage/indexedDbService
 * Implementación de {@link StorageAdapter} sobre IndexedDB (`routine_tracker_db` v2).
 *
 * Esquema v2:
 *   tasks           keyPath `id`      · idx_section, idx_order, idx_archived
 *   daily_logs      keyPath `date`    · idx_completion_rate
 *   system_metadata keyPath `key`
 *
 * La ruta de upgrade contempla:
 *   0 → 2  instalación limpia
 *   1 → 2  crea `daily_logs` y `system_metadata` y conserva el store legado
 *          `app_state` para que la migración de datos ocurra fuera de la
 *          transacción de upgrade (donde no se pueden usar promesas).
 */

import { StorageAdapter, StorageError } from './storageAdapter.js';
import { DB_NAME, DB_VERSION, STORES, INDICES } from '../core/constants.js';

export class IndexedDbService extends StorageAdapter {
  constructor(dbName = DB_NAME, version = DB_VERSION) {
    super();
    this._dbName = dbName;
    this._version = version;
    /** @type {IDBDatabase|null} */
    this._db = null;
    /** @type {Promise<IDBDatabase>|null} */
    this._opening = null;
    /** @type {{from:number, to:number}|null} Upgrade observado en la última apertura. */
    this.lastUpgrade = null;
  }

  get engine() {
    return 'indexeddb';
  }

  static async isSupported() {
    if (typeof indexedDB === 'undefined' || indexedDB === null) return false;
    try {
      // Safari en modo privado expone el objeto pero falla al abrir.
      await new Promise((resolve, reject) => {
        const probe = indexedDB.open('__routine_tracker_probe__', 1);
        probe.onsuccess = () => {
          probe.result.close();
          try { indexedDB.deleteDatabase('__routine_tracker_probe__'); } catch { /* noop */ }
          resolve();
        };
        probe.onerror = () => reject(probe.error ?? new Error('probe failed'));
        probe.onblocked = () => resolve();
      });
      return true;
    } catch {
      return false;
    }
  }

  /** @returns {Promise<IDBDatabase>} */
  async init() {
    if (this._db) return this._db;
    if (this._opening) return this._opening;

    this._opening = new Promise((resolve, reject) => {
      let request;
      try {
        request = indexedDB.open(this._dbName, this._version);
      } catch (error) {
        reject(new StorageError('No se pudo abrir IndexedDB', { cause: error, code: 'OPEN_FAILED' }));
        return;
      }

      request.onupgradeneeded = (event) => {
        const db = request.result;
        this.lastUpgrade = { from: event.oldVersion, to: event.newVersion ?? this._version };
        applySchema(db, request.transaction, event.oldVersion);
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          // Otra pestaña migró el esquema: cerramos para no bloquearla.
          db.close();
          this._db = null;
          this._opening = null;
        };
        this._db = db;
        resolve(db);
      };

      request.onerror = () => reject(new StorageError('Apertura de IndexedDB rechazada', {
        cause: request.error,
        code: 'OPEN_REJECTED',
      }));
      request.onblocked = () => reject(new StorageError('IndexedDB bloqueada por otra pestaña', {
        code: 'BLOCKED',
      }));
    });

    try {
      return await this._opening;
    } catch (error) {
      this._opening = null;
      throw error;
    }
  }

  /**
   * Ejecuta una transacción y resuelve cuando `oncomplete` dispara (no cuando
   * la última petición resuelve): sólo entonces la escritura es durable.
   * @template T
   * @param {string|string[]} stores
   * @param {IDBTransactionMode} mode
   * @param {(tx: IDBTransaction) => T|Promise<T>} work
   * @returns {Promise<T>}
   */
  async transaction(stores, mode, work) {
    const db = await this.init();
    const names = Array.isArray(stores) ? stores : [stores];
    const missing = names.filter((name) => !db.objectStoreNames.contains(name));
    if (missing.length > 0) {
      throw new StorageError(`Store inexistente: ${missing.join(', ')}`, { code: 'NO_STORE' });
    }

    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(names, mode);
      } catch (error) {
        reject(new StorageError('No se pudo iniciar la transacción', { cause: error, code: 'TX_FAILED' }));
        return;
      }
      let result;
      let settled = false;
      tx.oncomplete = () => { settled = true; resolve(result); };
      tx.onerror = () => {
        if (settled) return;
        reject(new StorageError('Transacción fallida', { cause: tx.error, code: 'TX_ERROR' }));
      };
      tx.onabort = () => {
        if (settled) return;
        reject(new StorageError('Transacción abortada', { cause: tx.error, code: 'TX_ABORTED' }));
      };
      try {
        const maybe = work(tx);
        if (maybe && typeof maybe.then === 'function') {
          maybe.then((value) => { result = value; }, (error) => {
            try { tx.abort(); } catch { /* noop */ }
            reject(error);
          });
        } else {
          result = maybe;
        }
      } catch (error) {
        try { tx.abort(); } catch { /* noop */ }
        reject(error);
      }
    });
  }

  async get(store, key) {
    return this.transaction(store, 'readonly', (tx) => request(tx.objectStore(store).get(key)));
  }

  async getAll(store, query = {}) {
    return this.transaction(store, 'readonly', (tx) => {
      const objectStore = tx.objectStore(store);
      const source = query.index ? objectStore.index(query.index) : objectStore;
      const range = buildRange(query.range);
      return request(source.getAll(range, query.limit));
    });
  }

  async put(store, value) {
    await this.transaction(store, 'readwrite', (tx) => request(tx.objectStore(store).put(value)));
    return value;
  }

  async bulkPut(store, values) {
    if (!Array.isArray(values) || values.length === 0) return;
    await this.transaction(store, 'readwrite', (tx) => {
      const objectStore = tx.objectStore(store);
      for (const value of values) objectStore.put(value);
    });
  }

  async delete(store, key) {
    await this.transaction(store, 'readwrite', (tx) => request(tx.objectStore(store).delete(key)));
  }

  async clear(store) {
    await this.transaction(store, 'readwrite', (tx) => request(tx.objectStore(store).clear()));
  }

  async exportAll() {
    const db = await this.init();
    const names = [...db.objectStoreNames].filter((name) => name !== STORES.LEGACY_APP_STATE);
    /** @type {Object.<string, Array<*>>} */
    const data = {};
    for (const name of names) {
      data[name] = await this.getAll(name);
    }
    return { version: this._version, exportedAt: new Date().toISOString(), data };
  }

  async importAll(dump) {
    if (!dump || typeof dump !== 'object' || !dump.data) {
      throw new StorageError('Volcado inválido', { code: 'BAD_DUMP' });
    }
    const db = await this.init();
    const names = Object.keys(dump.data).filter((name) => db.objectStoreNames.contains(name));
    if (names.length === 0) return;
    // Una sola transacción sobre todos los stores: o entra todo, o nada.
    await this.transaction(names, 'readwrite', (tx) => {
      for (const name of names) {
        const objectStore = tx.objectStore(name);
        objectStore.clear();
        for (const value of dump.data[name]) objectStore.put(value);
      }
    });
  }

  async close() {
    this._db?.close();
    this._db = null;
    this._opening = null;
  }
}

/**
 * Crea stores e índices faltantes. Se ejecuta dentro de la transacción de
 * upgrade, por lo que sólo admite API síncrona de IndexedDB.
 * @param {IDBDatabase} db
 * @param {IDBTransaction|null} tx
 * @param {number} oldVersion
 */
function applySchema(db, tx, oldVersion) {
  if (!db.objectStoreNames.contains(STORES.TASKS)) {
    db.createObjectStore(STORES.TASKS, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(STORES.DAILY_LOGS)) {
    db.createObjectStore(STORES.DAILY_LOGS, { keyPath: 'date' });
  }
  if (!db.objectStoreNames.contains(STORES.SYSTEM_METADATA)) {
    db.createObjectStore(STORES.SYSTEM_METADATA, { keyPath: 'key' });
  }

  for (const [storeName, indices] of Object.entries(INDICES)) {
    const objectStore = tx?.objectStore(storeName);
    if (!objectStore) continue;
    for (const [indexName, keyPath] of Object.entries(indices)) {
      // El keyPath de un índice no se puede cambiar: en la v3, `idx_section`
      // pasó de apuntar a `section` a apuntar a `sectionId`, así que hay que
      // borrarlo y volver a crearlo dentro de la transacción de upgrade.
      if (oldVersion > 0 && oldVersion < 3 && indexName === 'idx_section'
        && objectStore.indexNames.contains(indexName)) {
        objectStore.deleteIndex(indexName);
      }
      if (!objectStore.indexNames.contains(indexName)) {
        // `isArchived` es booleano: IndexedDB no indexa booleanos, por eso el
        // repositorio persiste 0/1 en `archivedFlag` y el índice apunta ahí.
        objectStore.createIndex(indexName, keyPath === 'isArchived' ? 'archivedFlag' : keyPath, {
          unique: false,
        });
      }
    }
  }

  // v2 → v3 sólo cambia la forma de los registros de `tasks`, que se reescriben
  // fuera de esta transacción (`repository.migrateSchema`): aquí no se puede
  // validar con el dominio porque `onupgradeneeded` no admite promesas.

  if (oldVersion > 0 && oldVersion < 2) {
    // El store legado se conserva: `repository.migrateLegacy()` lo vacía tras
    // convertir su contenido al esquema v2.
    if (!db.objectStoreNames.contains(STORES.LEGACY_APP_STATE)) {
      db.createObjectStore(STORES.LEGACY_APP_STATE, { keyPath: 'key' });
    }
  }
}

/**
 * @template T
 * @param {IDBRequest<T>} req
 * @returns {Promise<T>}
 */
function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new StorageError('Petición IndexedDB fallida', {
      cause: req.error,
      code: 'REQUEST_FAILED',
    }));
  });
}

/**
 * @param {{lower?:*, upper?:*, lowerOpen?:boolean, upperOpen?:boolean}} [range]
 * @returns {IDBKeyRange|null}
 */
function buildRange(range) {
  if (!range) return null;
  const { lower, upper, lowerOpen = false, upperOpen = false } = range;
  if (lower !== undefined && upper !== undefined) return IDBKeyRange.bound(lower, upper, lowerOpen, upperOpen);
  if (lower !== undefined) return IDBKeyRange.lowerBound(lower, lowerOpen);
  if (upper !== undefined) return IDBKeyRange.upperBound(upper, upperOpen);
  return null;
}
