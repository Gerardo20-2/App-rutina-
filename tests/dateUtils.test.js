import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toDateKey, fromDateKey, isDateKey, addDays, diffDays, rangeDays,
  msUntilNextMidnight, weekdayIndex, currentSection,
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

test('currentSection reparte la jornada en tres bloques', () => {
  assert.equal(currentSection(new Date(2026, 8, 21, 8)), 'morning');
  assert.equal(currentSection(new Date(2026, 8, 21, 15)), 'afternoon');
  assert.equal(currentSection(new Date(2026, 8, 21, 22)), 'evening');
});

test('fromDateKey devuelve medianoche local', () => {
  const date = fromDateKey('2026-09-21');
  assert.equal(date.getHours(), 0);
  assert.equal(date.getDate(), 21);
  assert.throws(() => fromDateKey('2026-13-01'), RangeError);
});
