/**
 * @module security/rateLimiter
 * Freno progresivo a los intentos fallidos de descifrado en la interfaz.
 *
 *   fallos 1–3  la respuesta se retrasa 500 ms
 *   fallo 4     bloqueo de 5 s
 *   fallo 5     bloqueo de 30 s
 *   fallo n ≥ 6 bloqueo de 2^(n−5) × 30 s (60 s, 120 s, …), con techo de 24 h
 *
 * Todo retardo lleva un jitter aleatorio de `crypto.getRandomValues`, y toda
 * respuesta fallida tarda al menos `FAILURE_FLOOR_MS`: así un checksum roto
 * (que falla antes del KDF) y una frase errónea (que falla después) no se
 * distinguen por el tiempo.
 *
 * Límite honesto: esto protege la **interfaz**. Quien tenga el archivo de
 * copia puede probar frases sin pasar por aquí, y el contador vive en memoria
 * (recargar la página lo reinicia). Contra un ataque fuera de línea la
 * defensa real es la longitud de la frase y el coste de PBKDF2.
 */

import { SECURITY_CONFIG } from '../core/constants.js';

/** Se lanza cuando se intenta descifrar durante un bloqueo. */
export class RateLimitError extends Error {
  /** @param {number} retryAfterMs */
  constructor(retryAfterMs) {
    super(`Demasiados intentos fallidos. Espera ${Math.ceil(retryAfterMs / 1000)} s`);
    this.name = 'RateLimitError';
    this.code = 'RATE_LIMITED';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Códigos de error que cuentan como intento de adivinar la frase. */
const COUNTED_CODES = new Set(['DECRYPT_FAILED', 'CHECKSUM_MISMATCH']);

/**
 * Penalización tras el fallo número `n` (1-based), sin jitter.
 * @param {number} n
 * @param {typeof SECURITY_CONFIG} [config]
 * @returns {{delayMs: number, lockMs: number}}
 */
export function penaltyFor(n, config = SECURITY_CONFIG) {
  if (n <= 0) return { delayMs: 0, lockMs: 0 };
  if (n <= 3) return { delayMs: config.SOFT_DELAY_MS, lockMs: 0 };
  if (n === 4) return { delayMs: 0, lockMs: config.LOCK_4_MS };
  const lockMs = Math.min(config.LOCK_MAX_MS, 2 ** (n - 5) * config.LOCK_5_MS);
  return { delayMs: 0, lockMs };
}

/**
 * Entero aleatorio en [0, max] de un CSPRNG.
 * @param {number} max
 */
export function cryptoJitter(max) {
  if (max <= 0) return 0;
  const [value] = globalThis.crypto.getRandomValues(new Uint32Array(1));
  return value % (max + 1);
}

export class AttemptLimiter {
  /**
   * @param {{
   *   now?: () => number,
   *   sleep?: (ms: number) => Promise<void>,
   *   jitter?: (max: number) => number,
   *   config?: typeof SECURITY_CONFIG,
   * }} [deps] inyectables para las pruebas.
   */
  constructor({
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    jitter = cryptoJitter,
    config = SECURITY_CONFIG,
  } = {}) {
    this._now = now;
    this._sleep = sleep;
    this._jitter = jitter;
    this._config = config;
    this.failures = 0;
    this.lockedUntil = 0;
  }

  /** Milisegundos de bloqueo restantes (0 si no hay bloqueo). */
  remainingLockMs() {
    return Math.max(0, this.lockedUntil - this._now());
  }

  /**
   * Ejecuta un intento de descifrado bajo el freno.
   * @template T
   * @param {() => Promise<T>} attempt
   * @returns {Promise<T>}
   * @throws {RateLimitError} si hay un bloqueo en curso (el intento no se ejecuta).
   */
  async run(attempt) {
    const remaining = this.remainingLockMs();
    if (remaining > 0) throw new RateLimitError(remaining);

    const started = this._now();
    try {
      const result = await attempt();
      this.failures = 0;
      return result;
    } catch (error) {
      let delayMs = 0;
      if (COUNTED_CODES.has(error?.code)) {
        this.failures += 1;
        const penalty = penaltyFor(this.failures, this._config);
        delayMs = penalty.delayMs;
        if (penalty.lockMs > 0) {
          const lockMs = penalty.lockMs + this._jitter(this._config.JITTER_MS);
          this.lockedUntil = this._now() + lockMs;
          // La UI lee este dato para mostrar la cuenta atrás.
          error.lockedForMs = lockMs;
        }
      }
      // Tiempo de respuesta uniforme: todo fallo tarda al menos el suelo, más
      // el retardo que toque, más jitter.
      const elapsed = this._now() - started;
      const pad = Math.max(0, this._config.FAILURE_FLOOR_MS - elapsed)
        + delayMs
        + this._jitter(this._config.JITTER_MS);
      await this._sleep(pad);
      throw error;
    }
  }

  reset() {
    this.failures = 0;
    this.lockedUntil = 0;
  }
}
