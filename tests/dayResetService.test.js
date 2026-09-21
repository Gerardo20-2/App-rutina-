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
  store.setState({
    streak: await repository.saveStreak({
      ...(await repository.getStreak()),
      currentStreak: 6, bestStreak: 6, lastEvaluatedDate: addDays(day0, -1),
    }),
  });

  const reset = new DayResetService({ repository, store, bus, now: clockAt(addDays(day0, 1)) });
  await reset.check('test');

  const streak = store.getState().streak;
  assert.equal(streak.currentStreak, 0);
  assert.equal(streak.bestStreak, 6);
});

test('un escudo absorbe el día perdido y se avisa por el bus', async () => {
  const { repository, store, bus } = await makeApp();
  const day0 = store.getState().today;
  store.setState({
    streak: await repository.saveStreak({
      currentStreak: 10, bestStreak: 10, shieldsAvailable: 1, shieldsUsedTotal: 0,
      weightedConsistencyScore: 80, lastEvaluatedDate: addDays(day0, -1),
    }),
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
  store.setState({
    streak: await repository.saveStreak({
      currentStreak: 3, bestStreak: 5, shieldsAvailable: 1, shieldsUsedTotal: 0,
      weightedConsistencyScore: 70, lastEvaluatedDate: addDays(day0, -1),
    }),
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

/**
 * Deja el estado de racha sincronizado en almacenamiento y en el store, que es
 * como queda tras una hidratación real.
 */
async function setStreak(repository, store, patch) {
  const streak = await repository.saveStreak({
    currentStreak: 0, bestStreak: 0, shieldsAvailable: 0, shieldsUsedTotal: 0,
    weightedConsistencyScore: 0, lastEvaluatedDate: null, ...patch,
  });
  store.setState({ streak });
  return streak;
}

test('un reloj por detrás del último día evaluado congela el cálculo diario', async () => {
  const { repository, store, bus, service } = await makeApp();
  const day0 = store.getState().today;
  await setStreak(repository, store, {
    currentStreak: 8, bestStreak: 8, shieldsAvailable: 2,
    weightedConsistencyScore: 90, lastEvaluatedDate: addDays(day0, -1),
  });
  const logBefore = await repository.getLog(day0);

  const events = [];
  bus.on(EVENTS.CLOCK_DESYNC, (payload) => events.push(payload));

  // El dispositivo retrocede tres días (viaje de husos, NTP o reloj a mano).
  const reset = new DayResetService({ repository, store, bus, now: clockAt(addDays(day0, -3)) });
  assert.equal(await reset.check('clock-skew'), false, 'no hay corte de día');

  const state = store.getState();
  assert.equal(state.today, day0, 'el día activo no retrocede');
  assert.equal(state.streak.currentStreak, 8, 'la racha se mantiene intacta');
  assert.equal(state.streak.shieldsAvailable, 2, 'no se consumen escudos');
  assert.equal(state.ui.clockDesynced, true);
  assert.equal(reset.state, RESET_STATE.FROZEN);
  assert.deepEqual(await repository.getLog(day0), logBefore, 'los logs no se tocan');
  assert.equal(events.length, 1);
  assert.equal(events[0].frozen, true);

  // Mientras está congelado, marcar tareas sigue funcionando.
  const [task] = state.tasks;
  await service.toggleTask(task.id);
  assert.equal(store.getState().log.completedCount, 1);

  // Y el aviso no se repite en cada comprobación.
  await reset.check('tick');
  assert.equal(events.length, 1, 'el aviso se emite una sola vez por episodio');
});

test('el cálculo se reanuda cuando el reloj vuelve a ser coherente', async () => {
  const { repository, store, bus } = await makeApp();
  const day0 = store.getState().today;
  await setStreak(repository, store, {
    currentStreak: 5, bestStreak: 5, lastEvaluatedDate: addDays(day0, -1),
  });

  const events = [];
  bus.on(EVENTS.CLOCK_DESYNC, (payload) => events.push(payload));

  const frozen = new DayResetService({ repository, store, bus, now: clockAt(addDays(day0, -2)) });
  await frozen.check('clock-skew');
  assert.equal(store.getState().ui.clockDesynced, true);

  // El reloj se corrige y avanza al día siguiente: el corte se ejecuta ya.
  const recovered = new DayResetService({ repository, store, bus, now: clockAt(addDays(day0, 1)) });
  assert.equal(await recovered.check('resync'), true);

  const state = store.getState();
  assert.equal(state.ui.clockDesynced, false, 'se descongela');
  assert.equal(state.today, addDays(day0, 1), 'el día avanza');
  assert.equal(state.streak.lastEvaluatedDate, day0, 'el día pendiente se evalúa');
  assert.deepEqual(events.map((event) => event.frozen), [true, false]);
});

test('un retroceso dentro del rango ya evaluado sólo reapunta el día activo', async () => {
  const { repository, store, bus } = await makeApp();
  const day0 = store.getState().today;
  await setStreak(repository, store, {
    currentStreak: 8, bestStreak: 8, shieldsAvailable: 2, lastEvaluatedDate: addDays(day0, -1),
  });

  // Hoy pasa a ser el último día evaluado: no es anterior, así que no congela,
  // pero tampoco debe reevaluarse nada hacia atrás.
  const reset = new DayResetService({ repository, store, bus, now: clockAt(addDays(day0, -1)) });
  await reset.check('clock-skew');

  const state = store.getState();
  assert.equal(state.today, addDays(day0, -1));
  assert.equal(state.streak.currentStreak, 8, 'la racha se mantiene intacta');
  assert.equal(state.streak.shieldsAvailable, 2, 'no se consumen escudos');
  assert.equal(state.ui.clockDesynced, false);
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
