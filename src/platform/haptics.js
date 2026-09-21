/**
 * @module platform/haptics
 * Retroalimentación háptica sobre la Vibration API.
 *
 * La API sólo existe en Android/Chromium: en iOS y escritorio las llamadas son
 * no-ops silenciosos.
 *
 * Los navegadores exigen **activación previa del usuario**: una llamada a
 * `vibrate()` antes del primer toque no sólo se ignora, sino que Chromium la
 * registra como error en consola. Como la aplicación puede querer vibrar por
 * un cambio de bloque horario que ocurre con la pestaña abierta pero sin que
 * nadie la haya tocado aún, la clase lleva su propio registro de activación y
 * no llama a la API hasta que hay un gesto real.
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
    /** ¿Hubo ya un gesto del usuario en este documento? */
    this._activated = options.activated ?? false;
    this._disposeActivation = null;
    this._watchActivation(options.target ?? globalThis.document);
  }

  /**
   * Marca la activación con el primer gesto real y se da de baja: a partir de
   * ahí, la API está disponible para el resto de la sesión.
   * @param {Document|null} target
   */
  _watchActivation(target) {
    if (this._activated || !target?.addEventListener) return;
    const onActivate = () => {
      this._activated = true;
      this._disposeActivation?.();
    };
    const events = ['pointerdown', 'keydown', 'touchstart'];
    for (const type of events) target.addEventListener(type, onActivate, { once: true, capture: true });
    this._disposeActivation = () => {
      for (const type of events) target.removeEventListener(type, onActivate, { capture: true });
      this._disposeActivation = null;
    };
  }

  /** @returns {boolean} el usuario ya interactuó con el documento. */
  get activated() {
    return this._activated;
  }

  /** @returns {boolean} el dispositivo expone la Vibration API. */
  get supported() {
    return this._supported;
  }

  get enabled() {
    return this._enabled && this._supported && this._activated;
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
