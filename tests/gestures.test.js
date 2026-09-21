import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SwipeRecognizer, GESTURE_STATE } from '../src/platform/gestures.js';
import { overshoot } from '../src/ui/components/touchTaskItem.js';
import { GESTURE_CONFIG } from '../src/core/constants.js';

const WIDTH = 360;

/**
 * Elemento mínimo con la superficie que usa el reconocedor. Permite probar la
 * máquina de estados del gesto sin navegador ni jsdom.
 */
function makeElement({ width = WIDTH } = {}) {
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    getBoundingClientRect: () => ({ width, height: 64, top: 0, left: 0, right: width, bottom: 64 }),
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture: () => true,
    dispatch(type, event) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

/** Recoge las llamadas de cada manejador del reconocedor. */
function makeHandlers(extra = {}) {
  const calls = { panStart: [], pan: [], commit: [], cancel: 0, tap: [] };
  return {
    calls,
    handlers: {
      onPanStart: (ctx) => calls.panStart.push(ctx),
      onPan: (ctx) => calls.pan.push(ctx),
      onCommit: (ctx) => calls.commit.push(ctx),
      onCancel: () => { calls.cancel += 1; },
      onTap: (ctx) => calls.tap.push(ctx),
      ...extra,
    },
  };
}

function pointer(x, y, time = 0) {
  return { pointerId: 1, pointerType: 'touch', button: 0, clientX: x, clientY: y, timeStamp: time, target: null };
}

/**
 * Arrastra en horizontal desde `from` hasta `to` en pasos regulares.
 * @returns {{calls: Object, element: Object}}
 */
function drag({ from = 40, to, steps = 10, stepMs = 16, release = true } = {}) {
  const element = makeElement();
  const { calls, handlers } = makeHandlers();
  new SwipeRecognizer(element, handlers);

  element.dispatch('pointerdown', pointer(from, 30, 0));
  for (let i = 1; i <= steps; i += 1) {
    const x = from + ((to - from) * i) / steps;
    element.dispatch('pointermove', pointer(x, 30, i * stepMs));
  }
  if (release) element.dispatch('pointerup', pointer(to, 30, steps * stepMs));
  return { calls, element };
}

test('un toque sin desplazamiento es un tap, no un swipe', () => {
  const { calls } = drag({ from: 100, to: 103, steps: 1 });
  assert.equal(calls.tap.length, 1);
  assert.equal(calls.panStart.length, 0);
  assert.equal(calls.commit.length, 0);
});

test('el movimiento vertical cede el gesto al scroll', () => {
  const element = makeElement();
  const { calls, handlers } = makeHandlers();
  const recognizer = new SwipeRecognizer(element, handlers);

  element.dispatch('pointerdown', pointer(100, 30, 0));
  element.dispatch('pointermove', pointer(104, 90, 16));
  assert.equal(recognizer.state, GESTURE_STATE.REJECTED);

  element.dispatch('pointermove', pointer(180, 120, 32));
  element.dispatch('pointerup', pointer(180, 120, 48));
  assert.equal(calls.panStart.length, 0, 'no entra en modo arrastre');
  assert.equal(calls.pan.length, 0);
  assert.equal(calls.tap.length, 0, 'tampoco cuenta como tap');
});

test('superar el 35 % del ancho confirma la acción', () => {
  const commitPx = WIDTH * GESTURE_CONFIG.COMMIT_RATIO;
  const { calls } = drag({ from: 20, to: 20 + commitPx + 10 });
  assert.equal(calls.commit.length, 1);
  assert.equal(calls.commit[0].direction, 1);
  assert.equal(calls.cancel, 0);
});

test('quedarse por debajo del umbral cancela y devuelve la fila', () => {
  const { calls } = drag({ from: 20, to: 20 + WIDTH * 0.2 });
  assert.equal(calls.commit.length, 0);
  assert.equal(calls.cancel, 1);
  assert.ok(calls.panStart.length === 1, 'hubo arrastre, sólo que insuficiente');
});

test('un gesto rápido y corto confirma por velocidad', () => {
  // 60 px en dos pasos de 4 ms: ~7 px/ms, muy por encima de FLING_VELOCITY.
  const { calls } = drag({ from: 20, to: 80, steps: 2, stepMs: 4 });
  assert.equal(calls.commit.length, 1);
  assert.ok(Math.abs(calls.commit[0].velocity) >= GESTURE_CONFIG.FLING_VELOCITY);
});

test('el swipe izquierdo se reporta con dirección negativa', () => {
  const { calls } = drag({ from: 300, to: 300 - WIDTH * 0.4 });
  assert.equal(calls.commit.length, 1);
  assert.equal(calls.commit[0].direction, -1);
});

test('pointercancel aborta el arrastre en curso', () => {
  const element = makeElement();
  const { calls, handlers } = makeHandlers();
  const recognizer = new SwipeRecognizer(element, handlers);

  element.dispatch('pointerdown', pointer(40, 30, 0));
  element.dispatch('pointermove', pointer(140, 30, 16));
  assert.equal(recognizer.state, GESTURE_STATE.PANNING);

  element.dispatch('pointercancel', pointer(140, 30, 32));
  assert.equal(recognizer.state, GESTURE_STATE.IDLE);
  assert.equal(calls.cancel, 1);
  assert.equal(calls.commit.length, 0);
});

test('el arrastre sigue al dedo 1:1 hasta el 50 % del ancho', () => {
  const half = WIDTH * GESTURE_CONFIG.FRICTION_RATIO;
  const { calls } = drag({ from: 0, to: half, steps: 5, release: false });
  for (const { dx } of calls.pan) {
    assert.ok(Math.abs(dx) <= half + 0.001, `dx ${dx} excede el tramo lineal`);
  }
  assert.ok(Math.abs(calls.pan.at(-1).dx - half) < 0.001, 'el último punto coincide con el dedo');
});

test('más allá del 50 % la fricción es logarítmica y monótona', () => {
  const half = WIDTH * GESTURE_CONFIG.FRICTION_RATIO;
  const { calls } = drag({ from: 0, to: WIDTH * 1.2, steps: 24, release: false });
  const beyond = calls.pan.filter((ctx) => ctx.dx > half);
  assert.ok(beyond.length > 3, 'hay muestras en la zona de fricción');

  for (const ctx of beyond) {
    assert.ok(ctx.dx < WIDTH * 1.2, 'el recorrido aplicado es menor que el del dedo');
  }
  // Monotonía: sigue avanzando, pero cada vez menos.
  const deltas = beyond.slice(1).map((ctx, i) => ctx.dx - beyond[i].dx);
  assert.ok(deltas.every((delta) => delta > 0), 'el elemento nunca retrocede');
  assert.ok(deltas.at(-1) < deltas[0], 'el avance por píxel de dedo decrece');
});

test('el ratio de avance satura en 1 al alcanzar el umbral', () => {
  const { calls } = drag({ from: 0, to: WIDTH, steps: 20, release: false });
  assert.ok(calls.pan.every((ctx) => ctx.ratio >= 0 && ctx.ratio <= 1));
  assert.equal(calls.pan.at(-1).ratio, 1);
  assert.equal(calls.pan.at(-1).width, WIDTH, 'el ancho viaja en el contexto');
});

test('overshoot cubre el tramo entre el umbral de disparo y la fricción', () => {
  const commitPx = WIDTH * GESTURE_CONFIG.COMMIT_RATIO;
  const frictionPx = WIDTH * GESTURE_CONFIG.FRICTION_RATIO;
  assert.equal(overshoot(0, WIDTH), 0);
  assert.equal(overshoot(commitPx, WIDTH), 0);
  assert.equal(overshoot(frictionPx, WIDTH), 1);
  assert.equal(overshoot(frictionPx * 2, WIDTH), 1, 'satura');
  assert.ok(overshoot((commitPx + frictionPx) / 2, WIDTH) > 0.4);
  assert.equal(overshoot(-frictionPx, WIDTH), 1, 'es simétrico en ambas direcciones');
});

test('destroy() desengancha todos los listeners', () => {
  const element = makeElement();
  const { handlers } = makeHandlers();
  const recognizer = new SwipeRecognizer(element, handlers);
  assert.equal(element.listenerCount('pointerdown'), 1);
  recognizer.destroy();
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
    assert.equal(element.listenerCount(type), 0, `queda un listener de ${type}`);
  }
});
