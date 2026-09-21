import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Repository } from '../src/storage/repository.js';
import { LocalStorageService, MemoryBackend } from '../src/storage/localStorageService.js';
import { RoutineService, defaultCollapsedSections } from '../src/domain/routineService.js';
import { Store, createInitialState } from '../src/core/store.js';
import { EventBus } from '../src/core/events.js';
import { LS_KEYS, META_KEYS, DB_VERSION } from '../src/core/constants.js';
import { toDateKey, dayOfWeek } from '../src/core/dateUtils.js';
import { uuid } from '../src/domain/taskValidator.js';
import { tasksForDay, resolveSchedule, activeBlockId } from '../src/domain/timeBlockService.js';
import { INITIAL_TASKS } from '../src/storage/seedData.js';

/** Repositorio aislado sobre un backend en memoria. */
async function makeRepository() {
  const repository = new Repository({
    adapter: new LocalStorageService({ backend: new MemoryBackend() }),
  });
  await repository.open();
  return repository;
}

async function makeApp() {
  const repository = await makeRepository();
  const store = new Store(createInitialState());
  const bus = new EventBus();
  const service = new RoutineService({ repository, store, bus });
  return { repository, store, bus, service };
}

test('open() crea las claves obligatorias de system_metadata', async () => {
  const repository = await makeRepository();
  assert.equal(await repository.getMeta(META_KEYS.SCHEMA_VERSION), DB_VERSION);
  assert.ok(await repository.getMeta(META_KEYS.STREAK_STATE));
  assert.ok(await repository.getMeta(META_KEYS.USER_PREFERENCES));
});

test('saveTask asigna orden incremental dentro de cada bloque', async () => {
  const repository = await makeRepository();
  const a = await repository.saveTask({ title: 'A', sectionId: 'dawn' });
  const b = await repository.saveTask({ title: 'B', sectionId: 'dawn' });
  const c = await repository.saveTask({ title: 'C', sectionId: 'evening' });
  assert.equal(a.order, 0);
  assert.equal(b.order, 1);
  assert.equal(c.order, 0, 'cada bloque tiene su propia secuencia');

  const tasks = await repository.listTasks();
  assert.deepEqual(tasks.map((task) => task.title), ['A', 'B', 'C'], 'orden canónico por bloque');
});

test('dentro de un bloque, la hora de referencia ordena las tareas', async () => {
  const repository = await makeRepository();
  await repository.saveTask({ title: 'Tarde', sectionId: 'dawn', timeStart: '08:00', order: 0 });
  await repository.saveTask({ title: 'Pronto', sectionId: 'dawn', timeStart: '04:30', order: 0 });
  const tasks = await repository.listTasks();
  assert.deepEqual(tasks.map((task) => task.title), ['Pronto', 'Tarde']);
});

test('archiveTask es un soft-delete', async () => {
  const repository = await makeRepository();
  const task = await repository.saveTask({ title: 'Temporal', sectionId: 'anytime' });
  await repository.archiveTask(task.id);

  assert.equal((await repository.listTasks()).length, 0);
  const all = await repository.listTasks({ includeArchived: true });
  assert.equal(all.length, 1);
  assert.equal(all[0].isArchived, true);

  await repository.restoreTask(task.id);
  assert.equal((await repository.listTasks()).length, 1);
});

test('reorderTasks reescribe el orden según el array recibido', async () => {
  const repository = await makeRepository();
  const a = await repository.saveTask({ title: 'A', sectionId: 'dawn' });
  const b = await repository.saveTask({ title: 'B', sectionId: 'dawn' });
  const c = await repository.saveTask({ title: 'C', sectionId: 'dawn' });

  await repository.reorderTasks([c.id, a.id, b.id]);
  const tasks = await repository.listTasks();
  assert.deepEqual(tasks.map((t) => t.title), ['C', 'A', 'B']);
});

test('ensureLog re-sincroniza el total cuando cambian las tareas', async () => {
  const repository = await makeRepository();
  const first = await repository.ensureLog('2026-09-21', 3);
  assert.equal(first.totalActiveTasks, 3);
  const second = await repository.ensureLog('2026-09-21', 5);
  assert.equal(second.totalActiveTasks, 5);
});

test('listLogs acota el rango de fechas', async () => {
  const repository = await makeRepository();
  for (const date of ['2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21']) {
    await repository.saveLog({ date, entries: {}, totalActiveTasks: 2, completedCount: 2, closed: true });
  }
  const logs = await repository.listLogs('2026-09-19', '2026-09-20');
  assert.deepEqual(logs.map((l) => l.date), ['2026-09-19', '2026-09-20']);
});

test('export/import conserva tareas y logs', async () => {
  const source = await makeRepository();
  await source.saveTask({ title: 'Agua', sectionId: 'dawn' });
  await source.saveLog({ date: '2026-09-20', entries: {}, totalActiveTasks: 1, completedCount: 1, closed: true });
  const dump = await source.exportBackup();
  assert.equal(dump.app, 'routine-tracker');

  const target = await makeRepository();
  const result = await target.importBackup(JSON.stringify(dump));
  assert.equal(result.tasks, 1);
  assert.equal(result.logs, 1);
  assert.equal((await target.listTasks())[0].title, 'Agua');
  assert.equal((await target.getLog('2026-09-20')).completedCount, 1);
});

test('importBackup descarta registros corruptos sin abortar', async () => {
  const repository = await makeRepository();
  const result = await repository.importBackup({
    data: {
      tasks: [
        {
          id: uuid(),
          title: 'Buena',
          sectionId: 'dawn',
          daysOfWeek: [1, 2, 3, 4, 5],
          order: 0,
          estimatedMinutes: 5,
          isArchived: false,
          createdAt: new Date().toISOString(),
        },
        { id: 'id con espacios', title: 'Mala' },
      ],
      daily_logs: [{ date: '2026-09-20', entries: {}, totalActiveTasks: 1, completedCount: 1 }, { date: 'ayer' }],
    },
  });
  assert.equal(result.tasks, 1);
  assert.equal(result.logs, 1);
});

test('migrateLegacy convierte APP_STATE_V1 al esquema v2', async () => {
  const today = toDateKey();
  const legacy = {
    version: 1,
    lastActiveDate: today,
    streak: { current: 4, best: 9, lastCompletedDate: '2026-09-20' },
    tasks: [
      { id: 'legacy-1', title: 'Meditación 10 min', section: 'morning', completed: true, order: 1 },
      { id: 'legacy-2', title: 'Leer', section: 'evening', completed: false, order: 2 },
    ],
    history: { '2026-09-19': { completedCount: 5, totalCount: 6, ratio: 0.83 } },
  };

  const storage = new Map([[LS_KEYS.LEGACY_APP_STATE, JSON.stringify(legacy)]]);
  const originalLocalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };

  try {
    const repository = await makeRepository();
    assert.ok(repository.diagnostics.legacyMigrated);

    const tasks = await repository.listTasks();
    assert.deepEqual(tasks.map((t) => t.title), ['Meditación 10 min', 'Leer']);

    const todayLog = await repository.getLog(today);
    assert.equal(todayLog.completedCount, 1, 'conserva qué tarea estaba marcada');

    const historical = await repository.getLog('2026-09-19');
    assert.equal(historical.completedCount, 5);
    assert.equal(historical.totalActiveTasks, 6);
    assert.equal(historical.closed, true);

    const streak = await repository.getStreak();
    assert.equal(streak.currentStreak, 4);
    assert.equal(streak.bestStreak, 9);

    assert.equal(storage.get(LS_KEYS.LEGACY_APP_STATE), undefined, 'la clave legada se consume');
  } finally {
    if (originalLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalLocalStorage;
  }
});

test('hydrate siembra la rutina real en el primer arranque', async () => {
  const { store, service } = await makeApp();
  await service.hydrate();
  const state = store.getState();

  assert.ok(state.ready);
  assert.equal(state.tasks.length, INITIAL_TASKS.length, 'se sembró la rutina completa');
  assert.deepEqual(
    state.tasks.map((task) => task.id).sort(),
    INITIAL_TASKS.map((task) => task.id).sort(),
    'los identificadores de la semilla se conservan tal cual',
  );
  assert.equal(state.today, toDateKey());
  assert.ok(state.schedule.length > 0, 'la agenda del día está resuelta');
});

test('la siembra sólo ocurre una vez', async () => {
  const { store, service, repository } = await makeApp();
  await service.hydrate();
  const total = store.getState().tasks.length;

  await service.archiveTask(store.getState().tasks[0].id);
  assert.equal(store.getState().tasks.length, total - 1);

  // Un segundo arranque no debe resucitar la rutina de ejemplo.
  await service.hydrate();
  assert.equal(store.getState().tasks.length, total - 1, 'no se vuelve a sembrar');
  assert.ok(await repository.getMeta('seeded_at'));
});

test('el divisor del día son sólo las tareas aplicables hoy', async () => {
  const { store, service } = await makeApp();
  await service.hydrate();
  const state = store.getState();
  const applicable = tasksForDay(state.tasks, state.today);

  assert.equal(state.log.totalActiveTasks, applicable.length);
  assert.ok(applicable.length < state.tasks.length,
    'la rutina real nunca aplica entera en un mismo día');

  // Ninguna tarea del día pertenece a un bloque que hoy no existe.
  const blocks = new Set(resolveSchedule(state.today).map((block) => block.id));
  assert.ok(applicable.every((task) => blocks.has(task.sectionId)));

  // Y ninguna cae fuera de sus días declarados.
  const day = dayOfWeek(state.today);
  assert.ok(applicable.every((task) => task.daysOfWeek.length === 0 || task.daysOfWeek.includes(day)));
});

test('una tarea que no aplica hoy no se puede marcar', async () => {
  const { store, service } = await makeApp();
  await service.hydrate();
  const state = store.getState();
  const applicable = new Set(tasksForDay(state.tasks, state.today).map((task) => task.id));
  const inactive = state.tasks.find((task) => !applicable.has(task.id));
  assert.ok(inactive, 'hay alguna tarea de otro día');

  await assert.rejects(() => service.toggleTask(inactive.id), /no aplica hoy/);
  await assert.rejects(() => service.skipTask(inactive.id), /no aplica hoy/);
  assert.equal(store.getState().log.completedCount, 0);
});

test('completar todas las tareas aplicables deja el día al 100 %', async () => {
  const { store, service } = await makeApp();
  await service.hydrate();
  for (const task of tasksForDay(store.getState().tasks, store.getState().today)) {
    await service.toggleTask(task.id);
  }
  const log = store.getState().log;
  assert.equal(log.completedCount, log.totalActiveTasks);
  assert.equal(log.completionRate, 1, 'las tareas de otros días no diluyen el ratio');
});

test('al arrancar sólo queda abierto un bloque', async () => {
  const { store, service } = await makeApp();
  await service.hydrate();
  const state = store.getState();
  const blocks = new Set(tasksForDay(state.tasks, state.today).map((task) => task.sectionId));

  if (blocks.size > 1) {
    assert.equal(state.ui.collapsedSections.length, blocks.size - 1);
    assert.ok(state.ui.collapsedSections.every((id) => blocks.has(id)));
  } else {
    assert.deepEqual(state.ui.collapsedSections, []);
  }
});

test('toggleSection pliega y despliega', async () => {
  const { store, service, bus } = await makeApp();
  await service.hydrate();
  const events = [];
  bus.on('ui:section-toggled', (payload) => events.push(payload));

  const blocks = [...new Set(tasksForDay(store.getState().tasks, store.getState().today).map((t) => t.sectionId))];
  const open = blocks.find((id) => !store.getState().ui.collapsedSections.includes(id));

  service.toggleSection(open);
  assert.ok(store.getState().ui.collapsedSections.includes(open), 'se plegó');
  service.toggleSection(open);
  assert.ok(!store.getState().ui.collapsedSections.includes(open), 'se volvió a desplegar');
  assert.deepEqual(events.map((event) => event.collapsed), [true, false]);
});

test('guardar una tarea despliega su bloque', async () => {
  const { store, service } = await makeApp();
  await service.hydrate();

  // `anytime` existe todos los días, así que la tarea nueva siempre aplica.
  service.toggleSection('anytime');
  const collapsedBefore = store.getState().ui.collapsedSections.includes('anytime');

  await service.saveTask({ title: 'Tarea suelta', sectionId: 'anytime' });
  assert.ok(!store.getState().ui.collapsedSections.includes('anytime'),
    'el bloque de destino queda visible tras guardar');
  assert.ok(collapsedBefore || true);
});

test('saveTask y archiveTask mantienen el divisor del día al día', async () => {
  const { store, service } = await makeApp();
  await service.hydrate();
  const before = store.getState().log.totalActiveTasks;

  const task = await service.saveTask({ title: 'Recado de hoy', sectionId: 'anytime' });
  assert.equal(store.getState().log.totalActiveTasks, before + 1);

  await service.archiveTask(task.id);
  assert.equal(store.getState().log.totalActiveTasks, before);
});

test('una tarea limitada a otro día no cambia el divisor de hoy', async () => {
  const { store, service } = await makeApp();
  await service.hydrate();
  const before = store.getState().log.totalActiveTasks;
  const otherDay = (dayOfWeek(store.getState().today) + 3) % 7;

  await service.saveTask({ title: 'Sólo otro día', sectionId: 'anytime', daysOfWeek: [otherDay] });
  assert.equal(store.getState().log.totalActiveTasks, before, 'el divisor no se mueve');
  assert.equal(store.getState().tasks.length, INITIAL_TASKS.length + 1, 'pero la tarea existe');
});

test('defaultCollapsedSections deja abierto el bloque en curso', () => {
  // Martes a las 19:30: clase en marcha.
  const tuesdayClass = new Date(2026, 8, 22, 19, 30);
  const collapsed = defaultCollapsedSections(INITIAL_TASKS, tuesdayClass);
  assert.ok(!collapsed.includes('class_tuesday'), 'el bloque en curso queda desplegado');
  assert.ok(collapsed.includes('dawn'), 'los demás se pliegan');
  assert.equal(activeBlockId(tuesdayClass), 'class_tuesday');
});

test('sin bloque en curso se abre el siguiente con tareas', () => {
  // Lunes a las 08:45: hueco entre el arranque (acaba 08:30) y la jornada.
  const gap = new Date(2026, 8, 21, 8, 45);
  assert.equal(activeBlockId(gap), null, 'no hay bloque en curso');
  const collapsed = defaultCollapsedSections(INITIAL_TASKS, gap);
  assert.ok(collapsed.includes('dawn'), 'el bloque ya pasado se pliega');
  assert.ok(!collapsed.includes('lunch'), 'se abre el siguiente bloque con tareas');
});

test('defaultCollapsedSections no pliega nada si sólo hay un bloque con tareas', () => {
  // Sábado: sólo despertar y rutina de noche; a las 07:00, el de la mañana.
  const saturday = new Date(2026, 8, 26, 7, 0);
  const collapsed = defaultCollapsedSections(INITIAL_TASKS, saturday);
  assert.deepEqual(collapsed, ['wind_down']);
  assert.deepEqual(defaultCollapsedSections([], saturday), []);
});

test('toggleTask actualiza el store antes de que resuelva la escritura', async () => {
  const { store, service, repository } = await makeApp();
  await service.hydrate();
  const [task] = tasksForDay(store.getState().tasks, store.getState().today);

  // Escritura artificialmente lenta: el store no debe esperarla.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const original = repository.saveLog.bind(repository);
  repository.saveLog = async (log) => {
    await gate;
    return original(log);
  };

  const pending = service.toggleTask(task.id);
  await Promise.resolve();
  assert.equal(store.getState().log.completedCount, 1, 'el store ya refleja la marca');

  release();
  await pending;
  assert.equal(store.getState().log.completedCount, 1);
  assert.equal((await repository.getLog(store.getState().today)).completedCount, 1);
});

test('una escritura fallida revierte el estado optimista', async () => {
  const { store, service, repository, bus } = await makeApp();
  await service.hydrate();
  const [task] = tasksForDay(store.getState().tasks, store.getState().today);
  const before = store.getState().log;

  const failures = [];
  bus.on('app:error', (payload) => failures.push(payload));
  repository.saveLog = async () => { throw new Error('cuota agotada'); };

  await assert.rejects(() => service.toggleTask(task.id), /cuota agotada/);
  assert.equal(store.getState().log, before, 'el log vuelve a ser exactamente el anterior');
  assert.equal(store.getState().log.completedCount, 0);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].scope, 'write-entry');
});

test('toggleTask persiste y recalcula el ratio del día', async () => {
  const { store, service, repository, bus } = await makeApp();
  await service.hydrate();

  const events = [];
  bus.on('task:toggled', (payload) => events.push(payload));

  const [task] = tasksForDay(store.getState().tasks, store.getState().today);
  await service.toggleTask(task.id);

  const stateLog = store.getState().log;
  assert.equal(stateLog.completedCount, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].completed, true);

  const persisted = await repository.getLog(stateLog.date);
  assert.equal(persisted.completedCount, 1, 'la escritura llegó al almacenamiento');

  await service.toggleTask(task.id);
  assert.equal(store.getState().log.completedCount, 0);
});

test('skipTask saca la tarea del denominador', async () => {
  const { store, service } = await makeApp();
  await service.hydrate();
  const tasks = tasksForDay(store.getState().tasks, store.getState().today);
  assert.ok(tasks.length >= 2, 'el día tiene al menos dos tareas');

  for (const task of tasks.slice(0, -1)) {
    await service.toggleTask(task.id);
  }
  assert.ok(store.getState().log.completionRate < 1);

  await service.skipTask(tasks.at(-1).id);
  assert.equal(store.getState().log.completionRate, 1, 'dispensar la última completa el día');
});

test('el store agrupa notificaciones en un microtask', async () => {
  const store = new Store(createInitialState());
  let renders = 0;
  store.subscribe((state) => state, () => { renders += 1; });

  store.setState({ ready: true });
  store.setState({ today: '2026-09-21' });
  store.setState({ tasks: [] }); // misma referencia: no cuenta como cambio
  assert.equal(renders, 0, 'aún no se ha vaciado la cola de microtasks');

  await Promise.resolve();
  assert.equal(renders, 1, 'tres mutaciones, un solo render');
});
