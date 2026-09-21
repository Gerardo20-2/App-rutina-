import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyDay, applyDay, reconcile, projectToday, nextConsistencyScore,
  daysToNextShield, computableTasks, effectiveRate,
} from '../src/domain/streakCalculator.js';
import { DAY_OUTCOME, STREAK_TRANSITION, STREAK_CONFIG, INITIAL_STREAK_STATE } from '../src/core/constants.js';

/** Log sintético con `total` tareas y `completed` completadas. */
function log(date, completed, total, skipped = 0) {
  const entries = {};
  for (let i = 0; i < skipped; i += 1) {
    entries[`skip-${i}`] = { completed: false, completedAt: null, skipped: true };
  }
  return {
    date,
    entries,
    totalActiveTasks: total,
    completedCount: completed,
    completionRate: total - skipped > 0 ? completed / (total - skipped) : 0,
  };
}

const base = { ...INITIAL_STREAK_STATE, lastEvaluatedDate: '2026-09-20' };

test('classifyDay aplica los umbrales τ_s = 0.8 y τ_p = 0.5', () => {
  assert.equal(classifyDay(log('2026-09-21', 8, 10)), DAY_OUTCOME.SUCCESS);
  assert.equal(classifyDay(log('2026-09-21', 7, 10)), DAY_OUTCOME.PARTIAL);
  assert.equal(classifyDay(log('2026-09-21', 5, 10)), DAY_OUTCOME.PARTIAL);
  assert.equal(classifyDay(log('2026-09-21', 4, 10)), DAY_OUTCOME.FAIL);
  assert.equal(classifyDay(log('2026-09-21', 0, 0)), DAY_OUTCOME.VOID);
});

test('las tareas dispensadas salen del denominador', () => {
  const day = log('2026-09-21', 4, 6, 2); // 4 de 4 computables
  assert.equal(computableTasks(day), 4);
  assert.equal(effectiveRate(day), 1);
  assert.equal(classifyDay(day), DAY_OUTCOME.SUCCESS);
});

test('un día de éxito extiende la racha y actualiza el máximo', () => {
  const { state, evaluation } = applyDay(base, log('2026-09-21', 10, 10));
  assert.equal(state.currentStreak, 1);
  assert.equal(state.bestStreak, 1);
  assert.equal(evaluation.transition, STREAK_TRANSITION.EXTENDED);
  assert.equal(state.lastEvaluatedDate, '2026-09-21');
});

test('un día parcial conserva la racha sin incrementarla', () => {
  const start = { ...base, currentStreak: 5, bestStreak: 9 };
  const { state, evaluation } = applyDay(start, log('2026-09-21', 6, 10));
  assert.equal(state.currentStreak, 5);
  assert.equal(state.bestStreak, 9);
  assert.equal(evaluation.transition, STREAK_TRANSITION.PRESERVED_PARTIAL);
});

test('un fallo rompe la racha cuando no hay escudos', () => {
  const start = { ...base, currentStreak: 12, bestStreak: 12 };
  const { state, evaluation } = applyDay(start, log('2026-09-21', 1, 10));
  assert.equal(state.currentStreak, 0);
  assert.equal(state.bestStreak, 12, 'el máximo histórico nunca retrocede');
  assert.equal(evaluation.transition, STREAK_TRANSITION.BROKEN);
});

test('un escudo absorbe el fallo y se contabiliza su consumo', () => {
  const start = { ...base, currentStreak: 12, shieldsAvailable: 2, shieldsUsedTotal: 1 };
  const { state, evaluation } = applyDay(start, log('2026-09-21', 0, 10));
  assert.equal(state.currentStreak, 12);
  assert.equal(state.shieldsAvailable, 1);
  assert.equal(state.shieldsUsedTotal, 2);
  assert.ok(evaluation.shieldConsumed);
  assert.equal(evaluation.transition, STREAK_TRANSITION.PRESERVED_BY_SHIELD);
});

test('se gana un escudo cada SHIELD_EARN_INTERVAL días, con tope', () => {
  let state = { ...base };
  for (let day = 1; day <= 28; day += 1) {
    state = applyDay(state, log('2026-09-21', 10, 10)).state;
  }
  assert.equal(state.currentStreak, 28);
  assert.equal(state.shieldsAvailable, STREAK_CONFIG.MAX_SHIELDS, 'no supera el máximo');
});

test('un día VOID no altera el estado', () => {
  const start = { ...base, currentStreak: 4, weightedConsistencyScore: 71.5 };
  const { state, evaluation } = applyDay(start, log('2026-09-21', 0, 0));
  assert.equal(state.currentStreak, 4);
  assert.equal(state.weightedConsistencyScore, 71.5);
  assert.equal(evaluation.outcome, DAY_OUTCOME.VOID);
});

test('el EWMA converge hacia la tasa reciente', () => {
  const alpha = 2 / (STREAK_CONFIG.CONSISTENCY_WINDOW + 1);
  assert.equal(nextConsistencyScore(0, 1, STREAK_CONFIG, { isFirstSample: true }), 100);
  const expected = Math.round((alpha * 100 + (1 - alpha) * 50) * 100) / 100;
  assert.equal(nextConsistencyScore(50, 1), expected);

  let score = 0;
  for (let i = 0; i < 100; i += 1) score = nextConsistencyScore(score, 1);
  assert.ok(score > 99.9 && score <= 100, `score convergido: ${score}`);
});

test('reconcile penaliza los días sin registro con tareas activas', () => {
  const start = { ...base, currentStreak: 3, lastEvaluatedDate: '2026-09-17' };
  const result = reconcile(start, {}, '2026-09-21', { defaultActiveTasks: 5 });
  // Evalúa 18, 19 y 20 (el 21 sigue abierto).
  assert.equal(result.evaluations.length, 3);
  assert.equal(result.state.currentStreak, 0);
  assert.equal(result.state.lastEvaluatedDate, '2026-09-20');
});

test('reconcile no penaliza cuando no había tareas activas', () => {
  const start = { ...base, currentStreak: 3, lastEvaluatedDate: '2026-09-17' };
  const result = reconcile(start, {}, '2026-09-21', { defaultActiveTasks: 0 });
  assert.equal(result.state.currentStreak, 3);
  assert.ok(result.evaluations.every((e) => e.outcome === DAY_OUTCOME.VOID));
});

test('reconcile aplica los logs existentes del hueco', () => {
  const start = { ...base, currentStreak: 1, lastEvaluatedDate: '2026-09-18' };
  const logs = {
    '2026-09-19': log('2026-09-19', 10, 10),
    '2026-09-20': log('2026-09-20', 9, 10),
  };
  const result = reconcile(start, logs, '2026-09-21', { defaultActiveTasks: 10 });
  assert.equal(result.state.currentStreak, 3);
  assert.equal(result.evaluations.map((e) => e.outcome).join(','), 'SUCCESS,SUCCESS');
});

test('reconcile sin fecha previa sólo ancla el estado', () => {
  const result = reconcile({ ...INITIAL_STREAK_STATE }, {}, '2026-09-21', { defaultActiveTasks: 5 });
  assert.equal(result.evaluations.length, 0);
  assert.equal(result.state.lastEvaluatedDate, '2026-09-20');
  assert.equal(result.state.currentStreak, 0);
});

test('reconcile trunca huecos absurdos y rompe la racha', () => {
  const start = { ...base, currentStreak: 40, lastEvaluatedDate: '2020-01-01' };
  const result = reconcile(start, {}, '2026-09-21', { defaultActiveTasks: 3 });
  assert.ok(result.truncated);
  assert.equal(result.state.currentStreak, 0);
  assert.equal(result.evaluations.length, STREAK_CONFIG.MAX_RECONCILE_DAYS);
});

test('reconcile es idempotente si ya se evaluó hasta ayer', () => {
  const start = { ...base, currentStreak: 7, lastEvaluatedDate: '2026-09-20' };
  const result = reconcile(start, {}, '2026-09-21', { defaultActiveTasks: 5 });
  assert.deepEqual(result.state, start);
  assert.equal(result.evaluations.length, 0);
});

test('projectToday anticipa el resultado sin mutar el estado', () => {
  const start = { ...base, currentStreak: 4 };
  const partial = projectToday(start, log('2026-09-21', 3, 10));
  assert.equal(partial.projectedStreak, 0, 'sin escudos, un día flojo rompería la racha');
  assert.ok(partial.atRisk);
  assert.equal(partial.remainingForSuccess, 5); // ceil(10 * 0.8) - 3

  const shielded = projectToday({ ...start, shieldsAvailable: 1 }, log('2026-09-21', 3, 10));
  assert.equal(shielded.projectedStreak, 4);

  const done = projectToday(start, log('2026-09-21', 9, 10));
  assert.equal(done.projectedStreak, 5);
  assert.equal(done.remainingForSuccess, 0);
  assert.equal(start.currentStreak, 4, 'el estado original no se toca');
});

test('daysToNextShield cuenta hasta el siguiente múltiplo', () => {
  assert.equal(daysToNextShield({ ...base, currentStreak: 5, shieldsAvailable: 0 }), 2);
  assert.equal(daysToNextShield({ ...base, currentStreak: 7, shieldsAvailable: 1 }), 7);
  assert.equal(daysToNextShield({ ...base, shieldsAvailable: STREAK_CONFIG.MAX_SHIELDS }), null);
});
