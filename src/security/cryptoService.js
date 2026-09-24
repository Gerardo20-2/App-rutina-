/**
 * @module security/cryptoService
 * Cifrado autenticado de datos con la Web Crypto API nativa, sin librerías.
 *
 *   KDF     PBKDF2-HMAC-SHA-256, 100 000 iteraciones, salt aleatorio de 16 bytes.
 *   Cifrado AES-GCM con clave de 256 bits e IV aleatorio de 12 bytes por operación.
 *
 * ## Sobre (envelope) de un backup cifrado
 *
 *     { format, version, kdf, iterations, cipher, salt, iv, ciphertext, checksum }
 *
 * `salt`, `iv` y `ciphertext` van en Base64. La cabecera completa (todo salvo
 * `ciphertext` y `checksum`) se pasa a AES-GCM como *additional data*: alterar
 * las iteraciones, el salt o el IV invalida la etiqueta de autenticación
 * igual que alterar el texto cifrado.
 *
 * `checksum` es el SHA-256 de cabecera + texto cifrado. Se comprueba ANTES de
 * derivar la clave: detecta corrupción o manipulación torpe sin gastar las
 * 100 000 iteraciones del KDF. Ojo: un SHA-256 sin clave lo puede recalcular
 * cualquiera; la garantía criptográfica de integridad la da la etiqueta GCM,
 * que sin la frase de paso no se puede falsificar.
 */

import { safeJsonParse } from './objectGuard.js';

export const ENVELOPE_FORMAT = 'routine-tracker-encrypted';
export const ENVELOPE_VERSION = 1;

export const CRYPTO_CONFIG = Object.freeze({
  KDF: 'PBKDF2-SHA-256',
  CIPHER: 'AES-GCM-256',
  ITERATIONS: 100_000,
  /** Techo al importar: un sobre manipulado no puede bloquear la app con un KDF eterno. */
  MAX_ITERATIONS: 5_000_000,
  SALT_BYTES: 16,
  IV_BYTES: 12,
  KEY_BITS: 256,
  /** Un PIN de 4 dígitos se prueba entero en segundos sin conexión: se exige más. */
  PASSPHRASE_MIN: 8,
});

/** Error criptográfico con código estable para la UI y las pruebas. */
export class CryptoError extends Error {
  /**
   * @param {string} message
   * @param {{code: 'UNSUPPORTED'|'WEAK_PASSPHRASE'|'BAD_ENVELOPE'|'CHECKSUM_MISMATCH'|'DECRYPT_FAILED', cause?: unknown}} options
   */
  constructor(message, { code, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CryptoError';
    this.code = code;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** @returns {SubtleCrypto} */
function subtle() {
  const api = globalThis.crypto?.subtle;
  if (!api) {
    // `crypto.subtle` sólo existe en contextos seguros (HTTPS o localhost).
    throw new CryptoError('Este navegador no ofrece cifrado nativo (Web Crypto)', { code: 'UNSUPPORTED' });
  }
  return api;
}

/**
 * Bytes aleatorios de un CSPRNG. Sin degradación a `Math.random`: una sal o
 * un IV predecibles anulan el cifrado.
 * @param {number} length
 * @returns {Uint8Array}
 */
export function randomBytes(length) {
  if (!globalThis.crypto?.getRandomValues) {
    throw new CryptoError('No hay generador aleatorio criptográfico', { code: 'UNSUPPORTED' });
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

/** @param {string} passphrase */
export function assertPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || [...passphrase].length < CRYPTO_CONFIG.PASSPHRASE_MIN) {
    throw new CryptoError(
      `La frase de paso necesita al menos ${CRYPTO_CONFIG.PASSPHRASE_MIN} caracteres`,
      { code: 'WEAK_PASSPHRASE' },
    );
  }
}

/**
 * PBKDF2 → clave AES-GCM no exportable.
 * @param {string} passphrase
 * @param {Uint8Array} salt
 * @param {number} [iterations]
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKey(passphrase, salt, iterations = CRYPTO_CONFIG.ITERATIONS) {
  const api = subtle();
  // NFC: la misma frase tecleada en dos teclados debe producir la misma clave.
  const material = await api.importKey(
    'raw', encoder.encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey'],
  );
  return api.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: CRYPTO_CONFIG.KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * SHA-256 en hexadecimal.
 * @param {string|Uint8Array} data
 * @returns {Promise<string>}
 */
export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  const digest = new Uint8Array(await subtle().digest('SHA-256', bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Cifra cualquier valor serializable a JSON.
 * @param {*} value
 * @param {string} passphrase
 * @returns {Promise<EncryptedEnvelope>}
 */
export async function encryptJson(value, passphrase) {
  assertPassphrase(passphrase);
  const salt = randomBytes(CRYPTO_CONFIG.SALT_BYTES);
  const iv = randomBytes(CRYPTO_CONFIG.IV_BYTES);
  const header = {
    format: ENVELOPE_FORMAT,
    version: ENVELOPE_VERSION,
    kdf: CRYPTO_CONFIG.KDF,
    iterations: CRYPTO_CONFIG.ITERATIONS,
    cipher: CRYPTO_CONFIG.CIPHER,
    salt: toBase64(salt),
    iv: toBase64(iv),
  };
  const key = await deriveKey(passphrase, salt, header.iterations);
  const ciphertext = new Uint8Array(await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(headerString(header)) },
    key,
    encoder.encode(JSON.stringify(value)),
  ));
  const envelope = { ...header, ciphertext: toBase64(ciphertext) };
  return { ...envelope, checksum: await checksumOf(envelope) };
}

/**
 * Verifica el checksum y descifra. Falla con {@link CryptoError} ante una
 * frase incorrecta, un sobre alterado o datos corruptos; nunca devuelve basura.
 * @param {EncryptedEnvelope|string} input sobre (objeto o JSON).
 * @param {string} passphrase
 * @returns {Promise<*>} el valor original, parseado sin claves peligrosas.
 */
export async function decryptJson(input, passphrase) {
  const envelope = parseEnvelope(input);

  const expected = await checksumOf(envelope);
  if (expected !== envelope.checksum) {
    throw new CryptoError('El archivo está dañado o ha sido modificado (checksum SHA-256)', {
      code: 'CHECKSUM_MISMATCH',
    });
  }

  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new CryptoError('Falta la frase de paso', { code: 'WEAK_PASSPHRASE' });
  }

  const salt = fromBase64(envelope.salt);
  const iv = fromBase64(envelope.iv);
  const key = await deriveKey(passphrase, salt, envelope.iterations);
  let plain;
  try {
    plain = await subtle().decrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(headerString(envelope)) },
      key,
      fromBase64(envelope.ciphertext),
    );
  } catch (error) {
    // AES-GCM no distingue entre clave errónea y texto alterado, y no debe:
    // cualquier pista sobre cuál de los dos falló ayuda a un atacante.
    throw new CryptoError('Frase de paso incorrecta o archivo alterado', { code: 'DECRYPT_FAILED', cause: error });
  }

  try {
    return safeJsonParse(decoder.decode(plain));
  } catch (error) {
    throw new CryptoError('El contenido descifrado no es JSON válido', { code: 'BAD_ENVELOPE', cause: error });
  }
}

/**
 * `true` si el valor tiene forma de sobre cifrado (no valida su contenido).
 * @param {*} value
 */
export function isEncryptedEnvelope(value) {
  return Boolean(value) && typeof value === 'object' && value.format === ENVELOPE_FORMAT;
}

/**
 * @typedef {Object} EncryptedEnvelope
 * @property {string} format
 * @property {number} version
 * @property {string} kdf
 * @property {number} iterations
 * @property {string} cipher
 * @property {string} salt       Base64, 16 bytes.
 * @property {string} iv         Base64, 12 bytes.
 * @property {string} ciphertext Base64, incluye la etiqueta GCM de 16 bytes.
 * @property {string} checksum   SHA-256 hex de cabecera + ciphertext.
 */

/**
 * Valida estructura y rangos del sobre antes de tocar la criptografía.
 * @param {EncryptedEnvelope|string} input
 * @returns {EncryptedEnvelope}
 */
function parseEnvelope(input) {
  let envelope = input;
  if (typeof input === 'string') {
    try {
      envelope = safeJsonParse(input);
    } catch (error) {
      throw new CryptoError('El archivo no es JSON válido', { code: 'BAD_ENVELOPE', cause: error });
    }
  }
  const bad = (detail) => new CryptoError(`Sobre cifrado inválido: ${detail}`, { code: 'BAD_ENVELOPE' });
  if (!isEncryptedEnvelope(envelope)) throw bad('formato desconocido');
  if (envelope.version !== ENVELOPE_VERSION) throw bad(`versión ${String(envelope.version)} no soportada`);
  if (envelope.kdf !== CRYPTO_CONFIG.KDF || envelope.cipher !== CRYPTO_CONFIG.CIPHER) throw bad('algoritmo no soportado');
  if (!Number.isInteger(envelope.iterations)
    || envelope.iterations < CRYPTO_CONFIG.ITERATIONS
    || envelope.iterations > CRYPTO_CONFIG.MAX_ITERATIONS) {
    throw bad('iteraciones fuera de rango');
  }
  for (const field of ['salt', 'iv', 'ciphertext', 'checksum']) {
    if (typeof envelope[field] !== 'string' || envelope[field].length === 0) throw bad(`falta ${field}`);
  }
  let salt;
  let iv;
  try {
    salt = fromBase64(envelope.salt);
    iv = fromBase64(envelope.iv);
    fromBase64(envelope.ciphertext);
  } catch {
    throw bad('Base64 corrupto');
  }
  if (salt.length !== CRYPTO_CONFIG.SALT_BYTES) throw bad('salt de longitud incorrecta');
  if (iv.length !== CRYPTO_CONFIG.IV_BYTES) throw bad('IV de longitud incorrecta');
  return envelope;
}

/** Serialización canónica de la cabecera: orden fijo, sin depender del JSON de entrada. */
function headerString(h) {
  return [h.format, h.version, h.kdf, h.iterations, h.cipher, h.salt, h.iv].join('|');
}

/** @param {EncryptedEnvelope} envelope */
function checksumOf(envelope) {
  return sha256Hex(`${headerString(envelope)}|${envelope.ciphertext}`);
}

/** @param {Uint8Array} bytes */
export function toBase64(bytes) {
  let binary = '';
  // Por tramos: `String.fromCharCode(...bytes)` desborda la pila con backups grandes.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** @param {string} text @returns {Uint8Array} */
export function fromBase64(text) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new TypeError('Base64 inválido');
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
