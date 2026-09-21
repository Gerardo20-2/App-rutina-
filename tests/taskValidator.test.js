import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  uuid, isUuid, isTaskId, normalizeDaysOfWeek, createTask, validateTask,
  validateDailyLog, createDailyLog, createExecutionRecord, validateStreakState,
  validatePreferences, ValidationError,
} from '../src/domain/taskValidator.js';
import { DEFAULT_PREFERENCES, LIMITS, STREAK_CONFIG } from '../src/core/constants.js';

test('uuid genera identificadores v4 válidos y distintos', () => {
  const a = uuid();
  const b = uuid();
  assert.ok(isUuid(a));
  assert.ok(isUuid(b));
  assert.notEqual(a, b);
  assert.ok(!isUuid('no-soy-un-uuid'));
});

test('createTask normaliza y completa los campos', () => {
  const task = createTask({ title: '  Meditar   10  min ', sectionId: 'dawn' });
  assert.equal(task.title, 'Meditar 10 min', 'recorta y colapsa espacios');
  assert.ok(isUuid(task.id));
  assert.equal(task.sectionId, 'dawn');
  assert.deepEqual(task.daysOfWeek, [], 'sin días declarados, aplica todos');
  assert.equal(task.isArchived, false);
  assert.equal(task.estimatedMinutes, 5);
  assert.ok(Date.parse(task.createdAt));
});

test('isTaskId admite UUID v4 y slugs estables', () => {
  assert.ok(isTaskId(uuid()));
  assert.ok(isTaskId('task-tue-class'));
  assert.ok(isTaskId('task_night_sleep'));
  assert.ok(!isTaskId('ab'), 'demasiado corto');
  assert.ok(!isTaskId('Task-Con-Mayúsculas'));
  assert.ok(!isTaskId('tarea con espacios'));
});

test('el bloque genérico de la v2 se recoge en el cajón sin horario', () => {
  for (const legacy of ['morning', 'afternoon', 'evening', 'anytime']) {
    assert.equal(createTask({ title: 'Vieja', section: legacy }).sectionId, 'anytime');
  }
});

test('isAnchor se hereda del bloque cuando no se declara', () => {
  assert.equal(createTask({ title: 'Clase', sectionId: 'class_tuesday' }).isAnchor, true);
  assert.equal(createTask({ title: 'Leer', sectionId: 'evening' }).isAnchor, false);
  assert.equal(createTask({ title: 'Clase', sectionId: 'class_tuesday', isAnchor: false }).isAnchor, false);
});

test('la duración se deduce del rango horario si no se declara', () => {
  assert.equal(createTask({ title: 'Comida', sectionId: 'lunch', timeStart: '14:00', timeEnd: '15:00' }).estimatedMinutes, 60);
  assert.equal(createTask({ title: 'Sueño', sectionId: 'wind_down', timeStart: '23:00', timeEnd: '00:00' }).estimatedMinutes, 60);
  assert.equal(createTask({ title: 'Clase', sectionId: 'class_friday', timeStart: '18:30', timeEnd: '20:30' }).estimatedMinutes, 120);
  assert.equal(createTask({ title: 'Suelta', sectionId: 'anytime' }).estimatedMinutes, 5);
});

test('normalizeDaysOfWeek limpia, ordena y colapsa la semana completa', () => {
  assert.deepEqual(normalizeDaysOfWeek([5, 1, 1, 3]).days, [1, 3, 5]);
  assert.deepEqual(normalizeDaysOfWeek([0, 1, 2, 3, 4, 5, 6]).days, [], 'siete días = todos');
  assert.deepEqual(normalizeDaysOfWeek(undefined).days, []);
  assert.ok(normalizeDaysOfWeek([1, 9]).invalid);
  assert.ok(normalizeDaysOfWeek('lunes').invalid);
});

test('validateTask rechaza entradas fuera de contrato', () => {
  assert.throws(() => createTask({ title: '' }), ValidationError);
  assert.throws(() => createTask({ title: 'x'.repeat(LIMITS.TASK_TITLE_MAX + 1) }), ValidationError);
  assert.throws(() => createTask({ title: 'ok', sectionId: 'madrugada' }), ValidationError);
  assert.throws(() => createTask({ title: 'ok', sectionId: 'dawn', daysOfWeek: [7] }), ValidationError);
  assert.throws(() => createTask({ title: 'ok', sectionId: 'dawn', timeStart: '25:00' }), ValidationError);
  assert.throws(() => validateTask({ title: 'sin id' }), ValidationError);
});

test('ValidationError enumera los campos problemáticos', () => {
  try {
    createTask({ title: '', sectionId: 'nope' });
    assert.fail('debería lanzar');
  } catch (error) {
    assert.ok(error instanceof ValidationError);
    const fields = error.issues.map((i) => i.field);
    assert.deepEqual(fields.sort(), ['sectionId', 'title']);
  }
});

test('createExecutionRecord mantiene la invariante skipped ⇒ !completed', () => {
  const record = createExecutionRecord({ completed: true, skipped: true });
  assert.equal(record.completed, false);
  assert.equal(record.completedAt, null);
  assert.equal(record.skipped, true);
});

test('validateDailyLog recalcula los agregados desde entries', () => {
  const id1 = uuid();
  const id2 = uuid();
  const id3 = uuid();
  const log = validateDailyLog({
    date: '2026-09-21',
    totalActiveTasks: 3,
    completedCount: 99, // valor mentiroso: debe ignorarse
    completionRate: 1,
    entries: {
      [id1]: { completed: true, completedAt: new Date().toISOString(), skipped: false },
      [id2]: { completed: false, completedAt: null, skipped: true },
      [id3]: { completed: false, completedAt: null, skipped: false },
    },
  });
  assert.equal(log.completedCount, 1);
  assert.equal(log.totalActiveTasks, 3);
  // 1 completada de 2 computables (una dispensada sale del denominador).
  assert.equal(log.completionRate, 0.5);
});

test('validateDailyLog respeta el contador declarado si no hay entries', () => {
  const log = validateDailyLog({ date: '2026-09-20', entries: {}, totalActiveTasks: 8, completedCount: 6 });
  assert.equal(log.completedCount, 6);
  assert.equal(log.completionRate, 0.75);
});

test('validateDailyLog admite slugs de la semilla y rechaza basura', () => {
  const log = validateDailyLog({
    date: '2026-09-21',
    totalActiveTasks: 2,
    entries: { 'task-tue-class': { completed: true }, 'task-night-sleep': { completed: false } },
  });
  assert.equal(log.completedCount, 1);

  assert.throws(() => validateDailyLog({
    date: '2026-09-21',
    entries: { 'clave con espacios': { completed: true } },
  }), ValidationError);
  assert.throws(() => validateDailyLog({ date: '21/09/2026' }), ValidationError);
});

test('createDailyLog produce un día vacío coherente', () => {
  const log = createDailyLog('2026-09-21', 4);
  assert.deepEqual(log, {
    date: '2026-09-21', entries: {}, totalActiveTasks: 4,
    completedCount: 0, completionRate: 0, closed: false,
  });
});

test('validateStreakState sanea rangos corruptos', () => {
  const state = validateStreakState({
    currentStreak: -4,
    bestStreak: 2,
    shieldsAvailable: 99,
    shieldsUsedTotal: '7',
    weightedConsistencyScore: 250,
    lastEvaluatedDate: 'mañana',
  });
  assert.equal(state.currentStreak, 0);
  assert.equal(state.shieldsAvailable, STREAK_CONFIG.MAX_SHIELDS);
  assert.equal(state.shieldsUsedTotal, 7);
  assert.equal(state.weightedConsistencyScore, 100);
  assert.equal(state.lastEvaluatedDate, null);
});

test('validateStreakState garantiza best >= current', () => {
  const state = validateStreakState({ currentStreak: 10, bestStreak: 2 });
  assert.equal(state.bestStreak, 10);
});

test('validatePreferences ignora claves desconocidas y castea tipos', () => {
  const prefs = validatePreferences(
    { hapticsEnabled: 0, theme: 'dark', inyectado: 'malicioso' },
    DEFAULT_PREFERENCES,
  );
  assert.equal(prefs.hapticsEnabled, false);
  assert.equal(prefs.theme, 'dark');
  assert.ok(!('inyectado' in prefs));
  assert.equal(prefs.wakeLockEnabled, DEFAULT_PREFERENCES.wakeLockEnabled);
});
