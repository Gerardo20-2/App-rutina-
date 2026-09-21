/**
 * @module platform/wakeLock
 * Screen Wake Lock API: mantiene la pantalla encendida mientras el usuario
 * ejecuta su rutina (p. ej. una sesión de estiramientos con el móvil apoyado).
 *
 * Detalles que la API obliga a manejar:
 *  - El sentinel se libera solo al ocultarse la pestaña; hay que **re-adquirirlo**
 *    en `visibilitychange`.
 *  - `request()` rechaza si el documento no es visible o el sistema está en
 *    ahorro de batería: es un rechazo esperado, no un error de la aplicación.
 *  - Sólo funciona en contextos seguros (HTTPS o localhost).
 */

export class WakeLockController {
  /** @param {{navigator?: Navigator, document?: Document}} [options] */
  constructor(options = {}) {
    this._nav = options.navigator ?? globalThis.navigator;
    this._doc = options.document ?? globalThis.document;
    /** @type {WakeLockSentinel|null} */
    this._sentinel = null;
    /** @type {boolean} Intención del usuario (independiente del estado real). */
    this._desired = false;
    this._onVisibility = null;
    /** @type {Set<(active: boolean) => void>} */
    this._listeners = new Set();
  }

  /** @returns {boolean} */
  get supported() {
    return Boolean(this._nav?.wakeLock?.request);
  }

  /** @returns {boolean} hay un sentinel vivo ahora mismo. */
  get active() {
    return this._sentinel !== null && this._sentinel.released !== true;
  }

  /**
   * @param {(active: boolean) => void} listener
   * @returns {() => void}
   */
  onChange(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /**
   * Solicita el bloqueo y lo mantiene hasta `release()`.
   * @returns {Promise<boolean>} `true` si quedó activo.
   */
  async request() {
    this._desired = true;
    if (!this.supported) return false;
    this._bindVisibility();
    return this._acquire();
  }

  /** Libera el bloqueo y deja de re-adquirirlo. @returns {Promise<void>} */
  async release() {
    this._desired = false;
    this._unbindVisibility();
    const sentinel = this._sentinel;
    this._sentinel = null;
    if (sentinel && sentinel.released !== true) {
      try {
        await sentinel.release();
      } catch { /* noop */ }
    }
    this._emit();
  }

  /** @param {boolean} enabled @returns {Promise<boolean>} */
  async toggle(enabled) {
    if (enabled) return this.request();
    await this.release();
    return false;
  }

  async _acquire() {
    if (this.active) return true;
    if (this._doc?.visibilityState !== 'visible') return false;
    try {
      this._sentinel = await this._nav.wakeLock.request('screen');
      this._sentinel.addEventListener?.('release', () => {
        this._sentinel = null;
        this._emit();
      });
      this._emit();
      return true;
    } catch (error) {
      // NotAllowedError es normal (batería baja, pestaña oculta): no se propaga.
      this._sentinel = null;
      this._emit();
      return false;
    }
  }

  _bindVisibility() {
    if (this._onVisibility || !this._doc) return;
    this._onVisibility = () => {
      if (this._desired && this._doc.visibilityState === 'visible') void this._acquire();
    };
    this._doc.addEventListener('visibilitychange', this._onVisibility);
  }

  _unbindVisibility() {
    if (!this._onVisibility || !this._doc) return;
    this._doc.removeEventListener('visibilitychange', this._onVisibility);
    this._onVisibility = null;
  }

  _emit() {
    for (const listener of this._listeners) {
      try {
        listener(this.active);
      } catch (error) {
        console.error('[WakeLock] listener falló', error);
      }
    }
  }
}

export const wakeLock = new WakeLockController();
