import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  uuid, isUuid, createTask, validateTask, validateDailyLog, createDailyLog,
  createExecutionRecord, validateStreakState, validatePreferences, ValidationError,
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
  const task = createTask({ title: '  Meditar   10  min ', section: 'morning' });
  assert.equal(task.title, 'Meditar 10 min', 'recorta y colapsa espacios');
  assert.ok(isUuid(task.id));
  assert.equal(task.isArchived, false);
  assert.equal(task.estimatedMinutes, 5);
  assert.ok(Date.parse(task.createdAt));
});

test('validateTask rechaza entradas fuera de contrato', () => {
  assert.throws(() => createTask({ title: '' }), ValidationError);
  assert.throws(() => createTask({ title: 'x'.repeat(LIMITS.TASK_TITLE_MAX + 1) }), ValidationError);
  assert.throws(() => createTask({ title: 'ok', section: 'madrugada' }), ValidationError);
  assert.throws(() => createTask({ title: 'ok', estimatedMinutes: -3 }), ValidationError);
  assert.throws(() => validateTask({ title: 'sin id' }), ValidationError);
});

test('ValidationError enumera los campos problemáticos', () => {
  try {
    createTask({ title: '', section: 'nope' });
    assert.fail('debería lanzar');
  } catch (error) {
    assert.ok(error instanceof ValidationError);
    const fields = error.issues.map((i) => i.field);
    assert.deepEqual(fields.sort(), ['section', 'title']);
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

test('validateDailyLog descarta claves que no son UUID', () => {
  assert.throws(() => validateDailyLog({
    date: '2026-09-21',
    entries: { 'tarea-1': { completed: true } },
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
