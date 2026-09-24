/**
 * @module security/integrityService
 * Firma HMAC-SHA-256 de los registros persistidos, con una clave ligada al
 * dispositivo.
 *
 * La clave se genera aquí con `extractable: false` y se guarda como
 * `CryptoKey` en el store `security_keys` de IndexedDB (el clonado
 * estructurado conserva el objeto opaco: los bytes nunca llegan a
 * JavaScript). Cada `daily_log` y el estado de racha llevan una firma sobre
 * su forma canónica; una edición hecha fuera del código de la app (DevTools,
 * una extensión que escribe en IndexedDB, un perfil del navegador copiado y
 * retocado) deja una firma que no cuadra.
 *
 * ## Modelo de amenaza, sin adornos
 *
 * Esto es **evidencia de manipulación**, no una barrera. Un script que ya se
 * ejecuta en el origen de la app puede leer la `CryptoKey` de IndexedDB y
 * pedirle a `crypto.subtle` que firme lo que quiera: no puede extraer la
 * clave, pero puede usarla. Lo que sí detecta: ediciones directas de los
 * registros (en DevTools, a mano o con herramientas que no pasan por
 * `Repository`), registros inyectados sin firma y firmas copiadas de otro día.
 */

/** Longitud en hex de una firma HMAC-SHA-256. */
const SIG_RE = /^[0-9a-f]{64}$/;

/** Nombre de la entrada de `security_keys` que guarda la clave HMAC. */
export const HMAC_KEY_NAME = 'integrity-hmac-v1';

const encoder = new TextEncoder();

/**
 * Forma canónica y determinista de un log diario. Incluye, además de los
 * agregados, un resumen de `entries`: los agregados se recalculan a partir de
 * las entradas al leer, así que firmar sólo aquellos dejaría pasar una
 * edición de las entradas.
 * @param {import('../domain/taskValidator.js').DailyLog} log ya validado.
 * @returns {string}
 */
export function canonicalLogPayload(log) {
  const entries = Object.keys(log.entries ?? {})
    .sort()
    .map((id) => {
      const record = log.entries[id];
      return `${id}:${record.completed ? 1 : 0}${record.skipped ? 1 : 0}`;
    })
    .join(',');
  return [
    'log.v1',
    log.date,
    log.completionRate,
    log.completedCount,
    log.totalActiveTasks,
    log.closed ? 1 : 0,
    entries,
  ].join('|');
}

/**
 * @param {import('../domain/streakCalculator.js').StreakState} streak ya validado.
 * @returns {string}
 */
export function canonicalStreakPayload(streak) {
  return [
    'streak.v1',
    streak.currentStreak,
    streak.bestStreak,
    streak.shieldsAvailable,
    streak.shieldsUsedTotal,
    streak.weightedConsistencyScore,
    streak.lastEvaluatedDate ?? '',
  ].join('|');
}

/**
 * Almacén de secretos que el adaptador de persistencia debe proveer.
 * @typedef {{
 *   getSecret: (name: string) => Promise<CryptoKey|undefined>,
 *   putSecret: (name: string, key: CryptoKey) => Promise<void>,
 * }} SecretStore
 */

export class IntegrityService {
  /**
   * @param {{secrets: SecretStore, subtle?: SubtleCrypto}} deps
   */
  constructor({ secrets, subtle = globalThis.crypto?.subtle }) {
    this._secrets = secrets;
    this._subtle = subtle;
    /** @type {CryptoKey|null} */
    this._key = null;
  }

  /** `true` cuando hay clave cargada y se puede firmar. */
  get ready() {
    return this._key !== null;
  }

  /**
   * Carga la clave del dispositivo o la genera si no existe.
   * @returns {Promise<{created: boolean}>}
   */
  async init() {
    if (!this._subtle) throw new Error('Web Crypto no disponible');
    const stored = await this._secrets.getSecret(HMAC_KEY_NAME);
    if (stored && typeof stored === 'object' && stored.type === 'secret') {
      this._key = stored;
      return { created: false };
    }
    this._key = await this._subtle.generateKey(
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false, // no exportable: ni este código puede leer los bytes de la clave
      ['sign', 'verify'],
    );
    await this._secrets.putSecret(HMAC_KEY_NAME, this._key);
    return { created: true };
  }

  /**
   * @param {string} payload
   * @returns {Promise<string>} firma en hexadecimal.
   */
  async sign(payload) {
    this._assertReady();
    const mac = new Uint8Array(await this._subtle.sign('HMAC', this._key, encoder.encode(payload)));
    return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Verificación en tiempo constante: se delega en `subtle.verify` en lugar
   * de comparar cadenas hex, que cortocircuita en el primer carácter distinto.
   * @param {string} payload
   * @param {*} signature
   * @returns {Promise<boolean>}
   */
  async verify(payload, signature) {
    this._assertReady();
    if (typeof signature !== 'string' || !SIG_RE.test(signature)) return false;
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) bytes[i] = parseInt(signature.slice(i * 2, i * 2 + 2), 16);
    return this._subtle.verify('HMAC', this._key, bytes, encoder.encode(payload));
  }

  /** @param {import('../domain/taskValidator.js').DailyLog} log */
  signLog(log) {
    return this.sign(canonicalLogPayload(log));
  }

  /** @param {import('../domain/taskValidator.js').DailyLog} log @param {*} signature */
  verifyLog(log, signature) {
    return this.verify(canonicalLogPayload(log), signature);
  }

  /** @param {import('../domain/streakCalculator.js').StreakState} streak */
  signStreak(streak) {
    return this.sign(canonicalStreakPayload(streak));
  }

  /** @param {import('../domain/streakCalculator.js').StreakState} streak @param {*} signature */
  verifyStreak(streak, signature) {
    return this.verify(canonicalStreakPayload(streak), signature);
  }

  _assertReady() {
    if (!this._key) throw new Error('IntegrityService sin inicializar');
  }
}
