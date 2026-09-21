import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EventBus } from '../src/core/events.js';

test('on/emit entrega la carga útil a cada suscriptor', () => {
  const bus = new EventBus();
  const received = [];
  bus.on('ping', (payload) => received.push(payload));
  bus.on('ping', (payload) => received.push(payload * 2));
  bus.emit('ping', 21);
  assert.deepEqual(received, [21, 42]);
});

test('la función devuelta por on() da de baja al suscriptor', () => {
  const bus = new EventBus();
  let calls = 0;
  const off = bus.on('ping', () => { calls += 1; });
  bus.emit('ping');
  off();
  off(); // idempotente
  bus.emit('ping');
  assert.equal(calls, 1);
  assert.equal(bus.listenerCount('ping'), 0);
});

test('once se ejecuta una sola vez', () => {
  const bus = new EventBus();
  let calls = 0;
  bus.once('ping', () => { calls += 1; });
  bus.emit('ping');
  bus.emit('ping');
  assert.equal(calls, 1);
});

test('un listener que lanza no impide la entrega al resto', () => {
  const bus = new EventBus();
  const originalError = console.error;
  console.error = () => {};
  try {
    let reached = false;
    bus.on('ping', () => { throw new Error('boom'); });
    bus.on('ping', () => { reached = true; });
    bus.emit('ping');
    assert.ok(reached);
  } finally {
    console.error = originalError;
  }
});

test('darse de baja durante la emisión no salta suscriptores', () => {
  const bus = new EventBus();
  const seen = [];
  const off = bus.on('ping', () => { seen.push('a'); off(); });
  bus.on('ping', () => seen.push('b'));
  bus.emit('ping');
  assert.deepEqual(seen, ['a', 'b']);
  bus.emit('ping');
  assert.deepEqual(seen, ['a', 'b', 'b']);
});

test('onAny observa todos los canales', () => {
  const bus = new EventBus();
  const seen = [];
  bus.onAny((type, payload) => seen.push([type, payload]));
  bus.emit('a', 1);
  bus.emit('b', 2);
  assert.deepEqual(seen, [['a', 1], ['b', 2]]);
});

test('on exige una función', () => {
  const bus = new EventBus();
  assert.throws(() => bus.on('ping', 'no soy función'), TypeError);
});
