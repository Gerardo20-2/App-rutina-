import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Repository } from '../src/storage/repository.js';
import { LocalStorageService, MemoryBackend } from '../src/storage/localStorageService.js';
import { RoutineService, defaultCollapsedSections } from '../src/domain/routineService.js';
import { Store, createInitialState } from '../src/core/store.js';
import { EventBus } from '../src/core/events.js';
import { LS_KEYS, META_KEYS, DB_VERSION } from '../src/core/constants.js';
import { toDateKey } from '../src/core/dateUtils.js';
import { uuid } from '../src/domain/taskValidator.js';

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
  const a = await repository.saveTask({ title: 'A', section: 'morning' });
  const b = await repository.saveTask({ title: 'B', section: 'morning' });
  const c = await repository.saveTask({ title: 'C', section: 'evening' });
  assert.equal(a.order, 0);
  assert.equal(b.order, 1);
  assert.equal(c.order, 0, 'cada bloque tiene su propia secuencia');

  const tasks = await repository.listTasks();
  assert.deepEqual(tasks.map((t) => t.title), ['A', 'B', 'C'], 'orden canónico por bloque');
});

test('archiveTask es un soft-delete', async () => {
  const repository = await makeRepository();
  const task = await repository.saveTask({ title: 'Temporal', section: 'anytime' });
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
  const a = await repository.saveTask({ title: 'A', section: 'morning' });
  const b = await repository.saveTask({ title: 'B', section: 'morning' });
  const c = await repository.saveTask({ title: 'C', section: 'morning' });

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
  await source.saveTask({ title: 'Agua', section: 'morning' });
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
      tasks: [{ id: uuid(), title: 'Buena', section: 'morning', order: 0, estimatedMinutes: 5, isArchived: false, createdAt: new Date().toISOString() },
        { id: 'no-uuid', title: 'Mala' }],
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

test('hydrate siembra la rutina de bienvenida en el primer arranque', async () => {
  const { store, service } = await makeApp();
  await service.hydrate();
  const state = store.getState();
  assert.ok(state.ready);
  assert.equal(state.tasks.length, 4, 'cuatro hábitos, uno por bloque del día');
  assert.equal(state.log.totalActiveTasks, state.tasks.length);
  assert.equal(state.today, toDateKey());

  const sections = state.tasks.map((task) => task.section);
  assert.deepEqual([...sections].sort(), ['afternoon', 'anytime', 'evening', 'morning']);
  assert.ok(state.tasks.every((task) => task.title.length > 0));
});

test('la siembra sólo ocurre una vez', async () => {
  const { store, service, repository } = await makeApp();
  await service.hydrate();
  await service.archiveTask(store.getState().tasks[0].id);
  assert.equal(store.getState().tasks.length, 3);

  // Un segundo arranque no debe resucitar la rutina de ejemplo.
  await service.hydrate();
  assert.equal(store.getState().tasks.length, 3, 'no se vuelve a sembrar');
  assert.ok(await repository.getMeta('seeded_at'));
});

test('al arrancar sólo queda abierto el bloque de la hora actual', async () => {
  const { store, service } = await makeApp();
  await service.hydrate();
  const { tasks, ui } = store.getState();
  const sections = [...new Set(tasks.map((task) => task.section))];
  assert.equal(ui.collapsedSections.length, sections.length - 1, 'un único bloque desplegado');
  assert.ok(ui.collapsedSections.every((section) => sections.includes(section)));
});

test('toggleSection pliega y despliega', async () => {
  const { store, service, bus } = await makeApp();
  await service.hydrate();
  const events = [];
  bus.on('ui:section-toggled', (payload) => events.push(payload));

  const open = ['morning', 'afternoon', 'evening', 'anytime']
    .find((section) => !store.getState().ui.collapsedSections.includes(section));

  service.toggleSection(open);
  assert.ok(store.getState().ui.collapsedSections.includes(open), 'se plegó');
  service.toggleSection(open);
  assert.ok(!store.getState().ui.collapsedSections.includes(open), 'se volvió a desplegar');
  assert.deepEqual(events.map((event) => event.collapsed), [true, false]);
});

test('guardar una tarea despliega su bloque', async () => {
  const { store, service } = await makeApp();
  await service.hydrate();
  const collapsed = store.getState().ui.collapsedSections[0];
  assert.ok(collapsed, 'hay al menos un bloque plegado');

  await service.saveTask({ title: 'Tarea nueva en bloque plegado', section: collapsed });
  assert.ok(!store.getState().ui.collapsedSections.includes(collapsed),
    'el bloque de destino queda visible tras guardar');
});

test('defaultCollapsedSections deja abierto el bloque de la hora', () => {
  const tasks = [
    { section: 'morning' }, { section: 'afternoon' }, { section: 'evening' }, { section: 'anytime' },
  ];
  assert.deepEqual(
    defaultCollapsedSections(tasks, new Date(2026, 8, 21, 8)),
    ['afternoon', 'evening', 'anytime'],
  );
  assert.deepEqual(
    defaultCollapsedSections(tasks, new Date(2026, 8, 21, 21)),
    ['morning', 'afternoon', 'anytime'],
  );
});

test('defaultCollapsedSections abre el primer bloque con tareas si el actual está vacío', () => {
  // Media tarde, pero sólo hay tareas de noche: plegarlo todo parecería un error.
  const tasks = [{ section: 'evening' }, { section: 'anytime' }];
  assert.deepEqual(defaultCollapsedSections(tasks, new Date(2026, 8, 21, 15)), ['anytime']);
});

test('defaultCollapsedSections no pliega nada si sólo hay un bloque', () => {
  assert.deepEqual(defaultCollapsedSections([{ section: 'morning' }], new Date(2026, 8, 21, 20)), []);
  assert.deepEqual(defaultCollapsedSections([], new Date(2026, 8, 21, 20)), []);
});

test('toggleTask actualiza el store antes de que resuelva la escritura', async () => {
  const { store, service, repository } = await makeApp();
  await service.hydrate();
  const [task] = store.getState().tasks;

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
  const [task] = store.getState().tasks;
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

  const [task] = store.getState().tasks;
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
  const tasks = store.getState().tasks;

  for (const task of tasks.slice(0, tasks.length - 1)) {
    await service.toggleTask(task.id);
  }
  const before = store.getState().log.completionRate;
  assert.ok(before < 1);

  await service.skipTask(tasks[tasks.length - 1].id);
  assert.equal(store.getState().log.completionRate, 1, 'dispensar la última completa el día');
});

test('saveTask y archiveTask mantienen el total del log al día', async () => {
  const { store, service } = await makeApp();
  await service.hydrate();
  const initial = store.getState().tasks.length;

  await service.saveTask({ title: 'Nueva tarea', section: 'anytime' });
  assert.equal(store.getState().tasks.length, initial + 1);
  assert.equal(store.getState().log.totalActiveTasks, initial + 1);

  const target = store.getState().tasks.at(-1);
  await service.archiveTask(target.id);
  assert.equal(store.getState().tasks.length, initial);
  assert.equal(store.getState().log.totalActiveTasks, initial);
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
