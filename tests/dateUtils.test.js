import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toDateKey, fromDateKey, isDateKey, addDays, diffDays, rangeDays,
  msUntilNextMidnight, weekdayIndex, dayOfWeek,
  parseTime, isTime, formatMinutes, normalizeRange, minutesOfDay,
} from '../src/core/dateUtils.js';

test('toDateKey usa el calendario local, no UTC', () => {
  // 23:30 locales del 21/09: en husos negativos, UTC ya sería el día 22.
  assert.equal(toDateKey(new Date(2026, 8, 21, 23, 30)), '2026-09-21');
  assert.equal(toDateKey(new Date(2026, 0, 1, 0, 0)), '2026-01-01');
});

test('isDateKey rechaza formatos y fechas inexistentes', () => {
  assert.ok(isDateKey('2026-02-28'));
  assert.ok(!isDateKey('2026-02-30'));
  assert.ok(!isDateKey('2026-2-8'));
  assert.ok(!isDateKey('ayer'));
  assert.ok(!isDateKey(null));
});

test('addDays cruza meses y años bisiestos', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29'); // 2024 es bisiesto
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
});

test('diffDays cuenta días de calendario', () => {
  assert.equal(diffDays('2026-09-21', '2026-09-21'), 0);
  assert.equal(diffDays('2026-09-21', '2026-09-24'), 3);
  assert.equal(diffDays('2026-09-24', '2026-09-21'), -3);
  assert.equal(diffDays('2025-01-01', '2026-01-01'), 365);
});

test('rangeDays produce un rango inclusivo y vacío si está invertido', () => {
  assert.deepEqual(rangeDays('2026-01-30', '2026-02-01'), ['2026-01-30', '2026-01-31', '2026-02-01']);
  assert.deepEqual(rangeDays('2026-02-01', '2026-01-30'), []);
});

test('msUntilNextMidnight siempre devuelve un valor positivo', () => {
  assert.ok(msUntilNextMidnight(new Date(2026, 8, 21, 23, 59, 59)) > 0);
  assert.ok(msUntilNextMidnight(new Date(2026, 8, 21, 0, 0, 0)) <= 86_400_050);
});

test('weekdayIndex trata el lunes como 0', () => {
  assert.equal(weekdayIndex('2026-09-21'), 0); // lunes
  assert.equal(weekdayIndex('2026-09-27'), 6); // domingo
});

test('dayOfWeek usa la numeración de getDay()', () => {
  assert.equal(dayOfWeek('2026-09-20'), 0, 'domingo');
  assert.equal(dayOfWeek('2026-09-21'), 1, 'lunes');
  assert.equal(dayOfWeek('2026-09-22'), 2, 'martes');
  assert.equal(dayOfWeek('2026-09-26'), 6, 'sábado');
  assert.equal(dayOfWeek(new Date(2026, 8, 25)), 5, 'viernes');
});

test('parseTime convierte HH:mm en minutos y rechaza lo demás', () => {
  assert.equal(parseTime('00:00'), 0);
  assert.equal(parseTime('04:30'), 270);
  assert.equal(parseTime('23:59'), 1439);
  assert.ok(isTime('09:05'));
  assert.ok(!isTime('9:05'));
  assert.ok(!isTime('25:00'));
  assert.ok(!isTime('12:60'));
  assert.ok(!isTime(830));
  assert.throws(() => parseTime('mediodía'), TypeError);
});

test('formatMinutes es inverso de parseTime', () => {
  for (const time of ['00:00', '04:30', '14:00', '20:30', '23:59']) {
    assert.equal(formatMinutes(parseTime(time)), time);
  }
  assert.equal(formatMinutes(1440), '24:00');
});

test('normalizeRange trata el fin 00:00 como final del día', () => {
  assert.deepEqual(normalizeRange('23:00', '00:00'), { start: 1380, end: 1440 });
  assert.deepEqual(normalizeRange('09:00', '14:00'), { start: 540, end: 840 });
  assert.deepEqual(normalizeRange('21:30', '00:00'), { start: 1290, end: 1440 });
});

test('minutesOfDay cuenta desde la medianoche local', () => {
  assert.equal(minutesOfDay(new Date(2026, 8, 21, 0, 0)), 0);
  assert.equal(minutesOfDay(new Date(2026, 8, 21, 17, 45)), 1065);
});

test('fromDateKey devuelve medianoche local', () => {
  const date = fromDateKey('2026-09-21');
  assert.equal(date.getHours(), 0);
  assert.equal(date.getDate(), 21);
  assert.throws(() => fromDateKey('2026-13-01'), RangeError);
});
