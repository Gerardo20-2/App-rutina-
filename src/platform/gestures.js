/**
 * @module platform/gestures
 * Reconocedor de swipe horizontal basado en Pointer Events (un solo camino de
 * código para ratón, dedo y lápiz).
 *
 * ## Máquina de estados
 *
 *   IDLE ──pointerdown──▶ PRESSED
 *   PRESSED ──|dx| > PAN_THRESHOLD y |dx| > |dy|──▶ PANNING   (captura el puntero)
 *   PRESSED ──|dy| domina──▶ REJECTED                          (el scroll vertical gana)
 *   PRESSED ──pointerup con |d| < TAP_SLOP──▶ IDLE + onTap
 *   PANNING ──pointerup: |dx| ≥ ancho·COMMIT_RATIO ó v ≥ FLING──▶ SETTLING + onCommit
 *   PANNING ──pointerup por debajo del umbral──▶ SETTLING + onCancel
 *   * ──pointercancel / lostpointercapture──▶ SETTLING + onCancel
 *
 * El bloqueo de eje es deliberado: en una lista vertical, un swipe diagonal
 * debe hacer scroll, no descartar tareas. Una vez elegido el eje, no se
 * reevalúa durante el mismo gesto.
 *
 * El elemento debe declarar `touch-action: pan-y` para que el navegador ceda
 * el eje horizontal sin que haga falta `preventDefault()` en cada `pointermove`.
 */

import { GESTURE_CONFIG } from '../core/constants.js';

/** @enum {string} */
export const GESTURE_STATE = Object.freeze({
  IDLE: 'IDLE',
  PRESSED: 'PRESSED',
  PANNING: 'PANNING',
  REJECTED: 'REJECTED',
  SETTLING: 'SETTLING',
});

/**
 * @typedef {Object} SwipeHandlers
 * @property {(ctx: {direction: number}) => void} [onPanStart]
 * @property {(ctx: {dx: number, ratio: number, direction: number, width: number}) => void} [onPan]
 * @property {(ctx: {direction: number, velocity: number, dx: number}) => void} [onCommit]
 * @property {() => void} [onCancel]
 * @property {(ctx: {x: number, y: number, target: EventTarget|null}) => void} [onTap]
 */

export class SwipeRecognizer {
  /**
   * @param {HTMLElement} element
   * @param {SwipeHandlers & {config?: typeof GESTURE_CONFIG, enabled?: () => boolean}} [handlers]
   */
  constructor(element, handlers = {}) {
    this._el = element;
    this._h = handlers;
    this._config = handlers.config ?? GESTURE_CONFIG;
    this.state = GESTURE_STATE.IDLE;

    this._pointerId = null;
    this._startX = 0;
    this._startY = 0;
    this._startTime = 0;
    this._lastX = 0;
    this._lastTime = 0;
    this._velocity = 0;
    this._width = 1;

    this._onDown = this._handleDown.bind(this);
    this._onMove = this._handleMove.bind(this);
    this._onUp = this._handleUp.bind(this);
    this._onCancel = this._handleCancel.bind(this);

    this._el.addEventListener('pointerdown', this._onDown);
    this._el.addEventListener('pointermove', this._onMove);
    this._el.addEventListener('pointerup', this._onUp);
    this._el.addEventListener('pointercancel', this._onCancel);
    this._el.addEventListener('lostpointercapture', this._onCancel);
  }

  /** Desconecta todos los listeners. */
  destroy() {
    this._el.removeEventListener('pointerdown', this._onDown);
    this._el.removeEventListener('pointermove', this._onMove);
    this._el.removeEventListener('pointerup', this._onUp);
    this._el.removeEventListener('pointercancel', this._onCancel);
    this._el.removeEventListener('lostpointercapture', this._onCancel);
    this.state = GESTURE_STATE.IDLE;
  }

  /** @param {PointerEvent} event */
  _handleDown(event) {
    if (this.state !== GESTURE_STATE.IDLE) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (this._h.enabled && !this._h.enabled()) return;

    this._pointerId = event.pointerId;
    this._startX = this._lastX = event.clientX;
    this._startY = event.clientY;
    this._startTime = this._lastTime = event.timeStamp;
    this._velocity = 0;
    this._width = Math.max(1, this._el.getBoundingClientRect().width);
    this.state = GESTURE_STATE.PRESSED;
  }

  /** @param {PointerEvent} event */
  _handleMove(event) {
    if (event.pointerId !== this._pointerId) return;
    if (this.state !== GESTURE_STATE.PRESSED && this.state !== GESTURE_STATE.PANNING) return;

    const dx = event.clientX - this._startX;
    const dy = event.clientY - this._startY;

    if (this.state === GESTURE_STATE.PRESSED) {
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > this._config.TAP_SLOP) {
        this.state = GESTURE_STATE.REJECTED; // el scroll vertical se queda el gesto
        return;
      }
      if (Math.abs(dx) < this._config.PAN_THRESHOLD) return;

      this.state = GESTURE_STATE.PANNING;
      try {
        this._el.setPointerCapture(event.pointerId);
      } catch { /* noop */ }
      this._h.onPanStart?.({ direction: Math.sign(dx) });
    }

    const elapsed = Math.max(1, event.timeStamp - this._lastTime);
    // Media móvil exponencial: absorbe el jitter de los últimos píxeles.
    this._velocity = 0.7 * ((event.clientX - this._lastX) / elapsed) + 0.3 * this._velocity;
    this._lastX = event.clientX;
    this._lastTime = event.timeStamp;

    this._h.onPan?.({
      dx: this._damp(dx),
      ratio: Math.min(1, Math.abs(dx) / (this._width * this._config.COMMIT_RATIO)),
      direction: Math.sign(dx),
      // El ancho viaja en el contexto porque la respuesta visual necesita
      // expresar el recorrido en fracciones del elemento, no en píxeles.
      width: this._width,
    });
  }

  /** @param {PointerEvent} event */
  _handleUp(event) {
    if (event.pointerId !== this._pointerId) return;
    const dx = event.clientX - this._startX;
    const dy = event.clientY - this._startY;
    const wasPanning = this.state === GESTURE_STATE.PANNING;
    this._release(event.pointerId);

    if (!wasPanning) {
      const travelled = Math.hypot(dx, dy);
      const wasRejected = this.state === GESTURE_STATE.REJECTED;
      this.state = GESTURE_STATE.IDLE;
      this._pointerId = null;
      if (!wasRejected && travelled <= this._config.TAP_SLOP) {
        this._h.onTap?.({ x: event.clientX, y: event.clientY, target: event.target });
      }
      return;
    }

    this.state = GESTURE_STATE.SETTLING;
    this._pointerId = null;

    const distanceCommit = Math.abs(dx) >= this._width * this._config.COMMIT_RATIO;
    const flingCommit = Math.abs(this._velocity) >= this._config.FLING_VELOCITY
      && Math.sign(this._velocity) === Math.sign(dx)
      && Math.abs(dx) > this._config.PAN_THRESHOLD * 2;

    if (distanceCommit || flingCommit) {
      this._h.onCommit?.({ direction: Math.sign(dx), velocity: this._velocity, dx });
    } else {
      this._h.onCancel?.();
    }
    this.state = GESTURE_STATE.IDLE;
  }

  /** @param {PointerEvent} event */
  _handleCancel(event) {
    if (this._pointerId !== null && event.pointerId !== this._pointerId) return;
    const wasPanning = this.state === GESTURE_STATE.PANNING;
    this._release(event.pointerId);
    this._pointerId = null;
    this.state = GESTURE_STATE.IDLE;
    if (wasPanning) this._h.onCancel?.();
  }

  _release(pointerId) {
    try {
      if (pointerId !== undefined && this._el.hasPointerCapture?.(pointerId)) {
        this._el.releasePointerCapture(pointerId);
      }
    } catch { /* noop */ }
  }

  /**
   * Fricción logarítmica más allá del 50 % del ancho.
   *
   *     dx' = L + k · ln(1 + (|dx| − L) / k),   L = ancho · FRICTION_RATIO
   *
   * El elemento sigue al dedo 1:1 mientras el gesto es informativo —incluido
   * todo el tramo hasta el umbral de disparo del 35 %— y a partir de la mitad
   * del ancho se frena de forma asintótica. La curva logarítmica no tiene
   * tope duro (nunca da la sensación de haber chocado) pero su derivada tiende
   * a cero, así que arrastrar más deja de producir recorrido y el usuario
   * percibe el límite sin que nada se detenga bruscamente.
   * @param {number} dx
   * @returns {number} desplazamiento a aplicar al elemento.
   */
  _damp(dx) {
    const limit = this._width * this._config.FRICTION_RATIO;
    const magnitude = Math.abs(dx);
    if (magnitude <= limit) return dx;
    const k = this._config.FRICTION_COEFFICIENT;
    const excess = magnitude - limit;
    return Math.sign(dx) * (limit + k * Math.log1p(excess / k));
  }
}

/**
 * Azúcar sintáctico para enlazar un swipe a un elemento.
 * @param {HTMLElement} element
 * @param {SwipeHandlers} handlers
 * @returns {SwipeRecognizer}
 */
export function attachSwipe(element, handlers) {
  return new SwipeRecognizer(element, handlers);
}
