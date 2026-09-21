import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Repository } from '../src/storage/repository.js';
import { LocalStorageService, MemoryBackend } from '../src/storage/localStorageService.js';
import { RoutineService } from '../src/domain/routineService.js';
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

test('hydrate siembra la rutina inicial en el primer arranque', async () => {
  const { store, service } = await makeApp();
  await service.hydrate();
  const state = store.getState();
  assert.ok(state.ready);
  assert.ok(state.tasks.length > 0, 'se sembraron tareas de ejemplo');
  assert.equal(state.log.totalActiveTasks, state.tasks.length);
  assert.equal(state.today, toDateKey());
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
