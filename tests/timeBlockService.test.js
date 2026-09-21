import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCK_CATALOG, BLOCK_IDS, resolveSchedule, activeBlock, activeBlockId, blockProgress,
  nextBoundaryMinute, isTaskActiveOn, tasksForDay, countTasksForDay, ruleFor,
  describeDays, isBlockId, TimeBlockWatcher,
} from '../src/domain/timeBlockService.js';
import { INITIAL_TASKS } from '../src/storage/seedData.js';

/** Semana de referencia: lunes 21 a domingo 27 de septiembre de 2026. */
const LUNES = '2026-09-21';
const MARTES = '2026-09-22';
const MIERCOLES = '2026-09-23';
const VIERNES = '2026-09-25';
const SABADO = '2026-09-26';
const DOMINGO = '2026-09-27';

const at = (day, hour, minute = 0) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, hour, minute);
};
const ids = (date) => resolveSchedule(date).map((block) => block.id);

test('el catálogo está bien formado', () => {
  for (const [id, block] of Object.entries(BLOCK_CATALOG)) {
    assert.equal(block.id, id, 'la clave y el id coinciden');
    assert.ok(block.label.length > 0);
    assert.ok(block.rules.length > 0, `${id} no declara reglas`);
    for (const rule of block.rules) {
      assert.ok(rule.days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6));
      assert.equal(Boolean(rule.start), Boolean(rule.end), `${id}: start y end van juntos`);
    }
  }
  assert.ok(isBlockId('class_friday'));
  assert.ok(!isBlockId('morning'), 'los bloques genéricos de la v2 ya no existen');
  assert.equal(BLOCK_IDS.length, Object.keys(BLOCK_CATALOG).length);
});

test('lunes, miércoles y jueves comparten la misma agenda', () => {
  const esperado = ['dawn', 'work_morning', 'lunch', 'work_afternoon', 'evening', 'wind_down', 'anytime'];
  assert.deepEqual(ids(LUNES), esperado);
  assert.deepEqual(ids(MIERCOLES), esperado);
  assert.deepEqual(ids('2026-09-24'), esperado, 'jueves');
});

test('el martes intercala DiDi, traslado y clase, y retrasa la tarde libre', () => {
  assert.deepEqual(ids(MARTES), [
    'dawn', 'work_morning', 'lunch', 'work_afternoon',
    'didi_shift', 'commute_home', 'class_tuesday', 'evening', 'wind_down', 'anytime',
  ]);
  const evening = resolveSchedule(MARTES).find((block) => block.id === 'evening');
  assert.equal(evening.start, 20 * 60 + 30, 'la tarde libre empieza al salir de clase');
  assert.equal(resolveSchedule(LUNES).find((block) => block.id === 'evening').start, 17 * 60);
});

test('el viernes cambia a la ruta de la escuela', () => {
  assert.deepEqual(ids(VIERNES), [
    'dawn', 'work_morning', 'lunch', 'work_afternoon',
    'commute_school', 'class_friday', 'commute_home_fri', 'night_weekend_prep', 'wind_down', 'anytime',
  ]);
  assert.equal(ruleFor('didi_shift', 5), null, 'el turno de DiDi no existe los viernes');
  assert.equal(ruleFor('evening', 5), null, 'el viernes cierra con night_weekend_prep');
});

test('el fin de semana tiene su propia agenda, con despertar distinto', () => {
  const finde = ['weekend_morning', 'weekend_afternoon', 'weekend_night', 'wind_down', 'anytime'];
  assert.deepEqual(ids(SABADO), finde);
  assert.deepEqual(ids(DOMINGO), finde);

  assert.equal(resolveSchedule(SABADO)[0].start, 5 * 60, 'sábado a las 05:00');
  assert.equal(resolveSchedule(DOMINGO)[0].start, 6 * 60, 'domingo a las 06:00');
  assert.equal(ruleFor('work_morning', 6), null, 'no hay jornada laboral el sábado');
});

test('la agenda sale ordenada por hora y el bloque sin horario va al final', () => {
  for (const day of [LUNES, MARTES, VIERNES, SABADO]) {
    const schedule = resolveSchedule(day);
    const timed = schedule.filter((block) => block.isTimed);
    for (let i = 1; i < timed.length; i += 1) {
      assert.ok(timed[i].start >= timed[i - 1].start, `${day}: bloques desordenados`);
    }
    assert.equal(schedule.at(-1).id, 'anytime');
    assert.equal(schedule.at(-1).isTimed, false);
  }
});

test('el bloque en curso es el más estrecho que contiene la hora', () => {
  assert.equal(activeBlockId(at(LUNES, 6)), 'dawn');
  assert.equal(activeBlockId(at(LUNES, 12)), 'work_morning');
  assert.equal(activeBlockId(at(LUNES, 14, 30)), 'lunch');
  assert.equal(activeBlockId(at(LUNES, 18)), 'evening');
  assert.equal(activeBlockId(at(MARTES, 17, 30)), 'didi_shift');
  assert.equal(activeBlockId(at(MARTES, 19, 30)), 'class_tuesday');
  assert.equal(activeBlockId(at(MARTES, 21)), 'evening');
  assert.equal(activeBlockId(at(VIERNES, 18)), 'commute_school');
  assert.equal(activeBlockId(at(VIERNES, 22)), 'night_weekend_prep');
});

test('los rangos solapados los resuelve el bloque más específico', () => {
  // Viernes 23:30: night_weekend_prep (21:30–00:00) y wind_down (23:00–00:00)
  // contienen el instante; gana el segundo por ser más estrecho.
  assert.equal(activeBlockId(at(VIERNES, 23, 30)), 'wind_down');
  assert.equal(activeBlockId(at(SABADO, 23, 30)), 'wind_down');
  assert.equal(activeBlockId(at(SABADO, 20)), 'weekend_night');
});

test('los huecos entre bloques no tienen bloque en curso', () => {
  assert.equal(activeBlockId(at(LUNES, 8, 45)), null, 'entre el arranque y la jornada');
  assert.equal(activeBlockId(at(LUNES, 3)), null, 'de madrugada');
  assert.equal(activeBlockId(at(DOMINGO, 5, 30)), null, 'antes del despertar dominical');
  assert.equal(activeBlock(at(LUNES, 3)), null);
});

test('blockProgress mide el avance dentro del bloque', () => {
  const lunch = resolveSchedule(LUNES).find((block) => block.id === 'lunch');
  assert.equal(blockProgress(lunch, at(LUNES, 14, 0)), 0);
  assert.equal(blockProgress(lunch, at(LUNES, 14, 30)), 0.5);
  assert.equal(blockProgress(lunch, at(LUNES, 15, 0)), 1);
  assert.equal(blockProgress(resolveSchedule(LUNES).at(-1), at(LUNES, 14)), 0, 'sin horario, sin progreso');
});

test('nextBoundaryMinute apunta al siguiente cambio de bloque', () => {
  assert.equal(nextBoundaryMinute(at(LUNES, 12)), 14 * 60, 'fin de la jornada de mañana');
  assert.equal(nextBoundaryMinute(at(MARTES, 17, 30)), 18 * 60);
  assert.equal(nextBoundaryMinute(at(LUNES, 23, 30)), 1440, 'ya no quedan bordes: medianoche');
});

test('una tarea aplica si su día lo permite y su bloque existe', () => {
  const didi = INITIAL_TASKS.find((task) => task.id === 'task-tue-didi');
  assert.ok(isTaskActiveOn(didi, MARTES));
  assert.ok(!isTaskActiveOn(didi, VIERNES), 'el turno de DiDi es sólo de martes');

  const sleep = INITIAL_TASKS.find((task) => task.id === 'task-night-sleep');
  for (const day of [LUNES, MARTES, VIERNES, SABADO, DOMINGO]) {
    assert.ok(isTaskActiveOn(sleep, day), `la rutina de noche aplica el ${day}`);
  }

  // Coherencia: «todos los días» no puede sacar una tarea de su bloque.
  const soloMartes = { sectionId: 'class_tuesday', daysOfWeek: [] };
  assert.ok(isTaskActiveOn(soloMartes, MARTES));
  assert.ok(!isTaskActiveOn(soloMartes, MIERCOLES), 'el bloque no existe ese día');

  assert.ok(!isTaskActiveOn({ sectionId: 'anytime', daysOfWeek: [], isArchived: true }, LUNES));
});

test('la rutina real produce el divisor correcto cada día', () => {
  const esperado = {
    [DOMINGO]: 2, [LUNES]: 5, [MARTES]: 8, [MIERCOLES]: 5,
    '2026-09-24': 5, [VIERNES]: 8, [SABADO]: 2,
  };
  for (const [day, total] of Object.entries(esperado)) {
    assert.equal(countTasksForDay(INITIAL_TASKS, day), total, `divisor del ${day}`);
  }
});

test('tasksForDay no deja pasar tareas de otros días', () => {
  const martes = tasksForDay(INITIAL_TASKS, MARTES).map((task) => task.id);
  assert.ok(martes.includes('task-tue-class'));
  assert.ok(!martes.includes('task-fri-class'));
  assert.ok(!martes.includes('task-sat-wake'));

  const sabado = tasksForDay(INITIAL_TASKS, SABADO).map((task) => task.id);
  assert.deepEqual(sabado.sort(), ['task-night-sleep', 'task-sat-wake']);
});

test('describeDays resume la recurrencia', () => {
  assert.equal(describeDays([]), 'Todos los días');
  assert.equal(describeDays([0, 1, 2, 3, 4, 5, 6]), 'Todos los días');
  assert.equal(describeDays([1, 2, 3, 4, 5]), 'Entre semana');
  assert.equal(describeDays([0, 6]), 'Fines de semana');
  assert.equal(describeDays([2]), 'Sólo martes');
  assert.equal(describeDays([1, 3]), 'L · X');
});

test('el vigilante avisa sólo cuando cambia el bloque', () => {
  let current = at(MARTES, 17, 30);
  const seen = [];
  const watcher = new TimeBlockWatcher({
    now: () => current,
    onChange: ({ blockId }) => seen.push(blockId),
  });

  assert.equal(watcher.check(), 'didi_shift');
  current = at(MARTES, 17, 45);
  assert.equal(watcher.check(), 'didi_shift');
  current = at(MARTES, 19, 15);
  assert.equal(watcher.check(), 'class_tuesday');
  current = at(MARTES, 20, 45);
  watcher.check();

  assert.deepEqual(seen, ['didi_shift', 'class_tuesday', 'evening'],
    'una notificación por transición, no por comprobación');
  watcher.stop();
});

test('el vigilante también avisa al cambiar de día aunque el bloque coincida', () => {
  let current = at(LUNES, 23, 30);
  const seen = [];
  const watcher = new TimeBlockWatcher({
    now: () => current,
    onChange: ({ blockId }) => seen.push(blockId),
  });

  watcher.check();
  current = at(MARTES, 23, 30); // mismo bloque, otro día
  watcher.check();
  assert.deepEqual(seen, ['wind_down', 'wind_down']);
  watcher.stop();
});

test('un error en el listener del vigilante no rompe la vigilancia', () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    let current = at(LUNES, 6);
    const watcher = new TimeBlockWatcher({
      now: () => current,
      onChange: () => { throw new Error('boom'); },
    });
    assert.doesNotThrow(() => watcher.check());
    current = at(LUNES, 12);
    assert.equal(watcher.check(), 'work_morning');
    watcher.stop();
  } finally {
    console.error = originalError;
  }
});
