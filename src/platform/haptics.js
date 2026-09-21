/**
 * @module platform/haptics
 * Retroalimentación háptica sobre la Vibration API.
 *
 * La API sólo existe en Android/Chromium: en iOS y escritorio las llamadas son
 * no-ops silenciosos. Además, los navegadores ignoran `vibrate()` si el
 * usuario no ha interactuado con el documento, así que los errores se tragan
 * deliberadamente: una vibración fallida nunca debe romper un flujo de UI.
 */

import { HAPTIC_PATTERNS } from '../core/constants.js';

export class Haptics {
  /** @param {{enabled?: boolean, navigator?: Navigator}} [options] */
  constructor(options = {}) {
    this._nav = options.navigator ?? globalThis.navigator;
    this._supported = typeof this._nav?.vibrate === 'function';
    this._enabled = options.enabled ?? true;
    /** Silencia ráfagas: dos patrones en menos de 30 ms se perciben como uno. */
    this._lastFire = 0;
  }

  /** @returns {boolean} el dispositivo expone la Vibration API. */
  get supported() {
    return this._supported;
  }

  get enabled() {
    return this._enabled && this._supported;
  }

  /** @param {boolean} value */
  setEnabled(value) {
    this._enabled = Boolean(value);
  }

  /**
   * Dispara un patrón declarado en {@link HAPTIC_PATTERNS}.
   * @param {keyof typeof HAPTIC_PATTERNS} name
   * @returns {boolean} `true` si la vibración se solicitó al sistema.
   */
  fire(name) {
    if (!this.enabled) return false;
    const pattern = HAPTIC_PATTERNS[name];
    if (pattern === undefined) return false;

    const now = Date.now();
    if (now - this._lastFire < 30) return false;
    this._lastFire = now;

    try {
      return Boolean(this._nav.vibrate(pattern));
    } catch {
      return false;
    }
  }

  /** Cancela cualquier vibración en curso. */
  cancel() {
    if (!this._supported) return;
    try {
      this._nav.vibrate(0);
    } catch { /* noop */ }
  }
}

export const haptics = new Haptics();
