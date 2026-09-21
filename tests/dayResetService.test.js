import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Repository } from '../src/storage/repository.js';
import { LocalStorageService, MemoryBackend } from '../src/storage/localStorageService.js';
import { RoutineService } from '../src/domain/routineService.js';
import { DayResetService } from '../src/domain/dayResetService.js';
import { Store, createInitialState } from '../src/core/store.js';
import { EventBus } from '../src/core/events.js';
import { RESET_STATE, EVENTS } from '../src/core/constants.js';
import { toDateKey, fromDateKey, addDays } from '../src/core/dateUtils.js';

/** Reloj controlable: devuelve el mediodía de la clave de día indicada. */
function clockAt(dateKey) {
  const date = fromDateKey(dateKey);
  date.setHours(12, 0, 0, 0);
  return () => new Date(date);
}

async function makeApp() {
  const repository = new Repository({
    adapter: new LocalStorageService({ backend: new MemoryBackend() }),
  });
  await repository.open();
  const store = new Store(createInitialState());
  const bus = new EventBus();
  const service = new RoutineService({ repository, store, bus });
  await service.hydrate();
  return { repository, store, bus, service };
}

test('sin cambio de día, check() no hace nada', async () => {
  const { repository, store, bus } = await makeApp();
  const reset = new DayResetService({ repository, store, bus, now: clockAt(store.getState().today) });
  assert.equal(await reset.check('test'), false);
  assert.equal(store.getState().streak.currentStreak, 0);
});

test('el corte de medianoche cierra el día y extiende la racha', async () => {
  const { repository, store, bus, service } = await makeApp();
  const day0 = store.getState().today;
  const day1 = addDays(day0, 1);

  for (const task of store.getState().tasks) await service.toggleTask(task.id);
  assert.equal(store.getState().log.completionRate, 1);

  const rolled = [];
  bus.on(EVENTS.DAY_ROLLED, (payload) => rolled.push(payload));

  const reset = new DayResetService({ repository, store, bus, now: clockAt(day1) });
  assert.equal(await reset.check('test'), true);

  assert.equal(store.getState().today, day1);
  assert.equal(store.getState().log.date, day1);
  assert.equal(store.getState().log.completedCount, 0, 'el día nuevo empieza limpio');
  assert.equal(store.getState().streak.currentStreak, 1);
  assert.equal(store.getState().streak.lastEvaluatedDate, day0);

  const closed = await repository.getLog(day0);
  assert.equal(closed.closed, true, 'el día anterior queda cerrado');
  assert.equal(closed.completedCount, store.getState().log.totalActiveTasks);

  assert.equal(rolled.length, 1);
  assert.equal(rolled[0].from, day0);
  assert.equal(rolled[0].evaluations.at(-1).outcome, 'SUCCESS');
  assert.equal(reset.state, RESET_STATE.IDLE, 'sin start(), no queda temporizador armado');
});

test('un día flojo rompe la racha al cerrarse', async () => {
  const { repository, store, bus } = await makeApp();
  const day0 = store.getState().today;
  await repository.saveStreak({ ...(await repository.getStreak()), currentStreak: 6, bestStreak: 6, lastEvaluatedDate: addDays(day0, -1) });

  const reset = new DayResetService({ repository, store, bus, now: clockAt(addDays(day0, 1)) });
  await reset.check('test');

  const streak = store.getState().streak;
  assert.equal(streak.currentStreak, 0);
  assert.equal(streak.bestStreak, 6);
});

test('un escudo absorbe el día perdido y se avisa por el bus', async () => {
  const { repository, store, bus } = await makeApp();
  const day0 = store.getState().today;
  await repository.saveStreak({
    currentStreak: 10, bestStreak: 10, shieldsAvailable: 1, shieldsUsedTotal: 0,
    weightedConsistencyScore: 80, lastEvaluatedDate: addDays(day0, -1),
  });

  const shielded = [];
  bus.on(EVENTS.SHIELD_CONSUMED, (payload) => shielded.push(payload));

  const reset = new DayResetService({ repository, store, bus, now: clockAt(addDays(day0, 1)) });
  await reset.check('test');

  assert.equal(store.getState().streak.currentStreak, 10);
  assert.equal(store.getState().streak.shieldsAvailable, 0);
  assert.equal(store.getState().streak.shieldsUsedTotal, 1);
  assert.equal(shielded.length, 1);
});

test('una ausencia de varios días se reconcilia en un solo arranque', async () => {
  const { repository, store, bus } = await makeApp();
  const day0 = store.getState().today;
  await repository.saveStreak({
    currentStreak: 3, bestStreak: 5, shieldsAvailable: 1, shieldsUsedTotal: 0,
    weightedConsistencyScore: 70, lastEvaluatedDate: addDays(day0, -1),
  });

  const reset = new DayResetService({ repository, store, bus, now: clockAt(addDays(day0, 4)) });
  await reset.check('bootstrap');

  const state = store.getState();
  assert.equal(state.today, addDays(day0, 4));
  // El escudo cubre el primer día perdido; los siguientes rompen la racha.
  assert.equal(state.streak.shieldsAvailable, 0);
  assert.equal(state.streak.currentStreak, 0);
  assert.equal(state.streak.lastEvaluatedDate, addDays(day0, 3));
  assert.equal(state.log.date, addDays(day0, 4));
});

test('check() es idempotente: dos llamadas no evalúan el día dos veces', async () => {
  const { repository, store, bus, service } = await makeApp();
  const day0 = store.getState().today;
  for (const task of store.getState().tasks) await service.toggleTask(task.id);

  const reset = new DayResetService({ repository, store, bus, now: clockAt(addDays(day0, 1)) });
  await reset.check('first');
  await reset.check('second');

  assert.equal(store.getState().streak.currentStreak, 1, 'la racha no se duplica');
});

test('un salto de reloj hacia atrás no reevalúa el pasado', async () => {
  const { repository, store, bus } = await makeApp();
  const day0 = store.getState().today;
  await repository.saveStreak({
    currentStreak: 8, bestStreak: 8, shieldsAvailable: 2, shieldsUsedTotal: 0,
    weightedConsistencyScore: 90, lastEvaluatedDate: addDays(day0, -1),
  });

  const reset = new DayResetService({ repository, store, bus, now: clockAt(addDays(day0, -3)) });
  await reset.check('clock-skew');

  assert.equal(store.getState().today, addDays(day0, -3));
  assert.equal(store.getState().streak.currentStreak, 8, 'la racha se mantiene intacta');
  assert.equal(store.getState().streak.shieldsAvailable, 2, 'no se consumen escudos');
});

test('el historial del heatmap se recarga tras el corte', async () => {
  const { repository, store, bus, service } = await makeApp();
  const day0 = store.getState().today;
  for (const task of store.getState().tasks) await service.toggleTask(task.id);

  const reset = new DayResetService({ repository, store, bus, now: clockAt(addDays(day0, 1)) });
  await reset.check('test');

  const history = store.getState().history;
  assert.ok(history[day0], 'el día cerrado aparece en el historial');
  assert.equal(history[day0].completionRate, 1);
});

test('start() y stop() no dejan temporizadores activos', async () => {
  const { repository, store, bus } = await makeApp();
  const reset = new DayResetService({ repository, store, bus, now: () => new Date() });
  reset.start();
  assert.equal(reset.state, RESET_STATE.SCHEDULED);
  reset.stop();
  assert.equal(reset.state, RESET_STATE.IDLE);
  assert.equal(toDateKey(), store.getState().today);
});
