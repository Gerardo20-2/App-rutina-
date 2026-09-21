/**
 * @module storage/seedData
 * Rutina real precargada en el primer arranque, cuando IndexedDB está vacía.
 *
 * Los identificadores son legibles y estables a propósito (`task-tue-class` en
 * vez de un UUID): así la semilla es idempotente —re-sembrar no duplica— y los
 * logs históricos siguen siendo interpretables al leerlos a mano.
 *
 * Los campos que faltan los completa `validateTask`: `isAnchor` se hereda del
 * bloque, `estimatedMinutes` se deduce de `timeStart`/`timeEnd` cuando ambos
 * están presentes, y `isArchived`/`createdAt` toman sus valores por defecto.
 */

/** @type {ReadonlyArray<Partial<import('../domain/taskValidator.js').TaskDefinition>>} */
export const INITIAL_TASKS = Object.freeze([
  // --- MADRUGADA / MAÑANA (Lunes a Viernes) ---
  {
    id: 'task-wake-up',
    title: 'Despertar y activación (04:30 - 05:00)',
    sectionId: 'dawn',
    daysOfWeek: [1, 2, 3, 4, 5],
    timeStart: '04:30',
    order: 1,
  },
  {
    id: 'task-commute-work',
    title: 'Traslado y llegada al trabajo antes de las 09:00',
    sectionId: 'dawn',
    daysOfWeek: [1, 2, 3, 4, 5],
    timeStart: '08:00',
    isAnchor: true,
    order: 2,
  },

  // --- JORNADA LABORAL Y COMIDA ---
  {
    id: 'task-lunch-break',
    title: 'Comida y desconexión laboral (14:00 - 15:00)',
    sectionId: 'lunch',
    daysOfWeek: [1, 2, 3, 4, 5],
    timeStart: '14:00',
    timeEnd: '15:00',
    order: 1,
  },
  {
    id: 'task-work-exit',
    title: 'Cierre de turno laboral (17:00)',
    sectionId: 'work_afternoon',
    daysOfWeek: [1, 2, 3, 4, 5],
    timeStart: '17:00',
    order: 2,
  },

  // --- MARTES: DIDI + TRASLADO + CLASE ---
  {
    id: 'task-tue-didi',
    title: 'Turno DiDi (17:00 - 18:00)',
    sectionId: 'didi_shift',
    daysOfWeek: [2],
    timeStart: '17:00',
    timeEnd: '18:00',
    order: 1,
  },
  {
    id: 'task-tue-commute-home',
    title: 'Llegar a casa (18:00 - 18:30 / 19:00)',
    sectionId: 'commute_home',
    daysOfWeek: [2],
    timeStart: '18:00',
    timeEnd: '19:00',
    order: 2,
  },
  {
    id: 'task-tue-class',
    title: 'Clase universitaria (19:00 - 20:30)',
    sectionId: 'class_tuesday',
    daysOfWeek: [2],
    timeStart: '19:00',
    timeEnd: '20:30',
    order: 3,
  },

  // --- VIERNES: RUTA ESCUELA + CLASE ---
  {
    id: 'task-fri-commute-school',
    title: 'Traslado a la escuela (Llegada 17:00 - 17:30)',
    sectionId: 'commute_school',
    daysOfWeek: [5],
    timeStart: '17:00',
    timeEnd: '18:30',
    order: 1,
  },
  {
    id: 'task-fri-class',
    title: 'Clase universitaria (18:30 - 20:30)',
    sectionId: 'class_friday',
    daysOfWeek: [5],
    timeStart: '18:30',
    timeEnd: '20:30',
    order: 2,
  },
  {
    id: 'task-fri-commute-home',
    title: 'Traslado y llegada a casa (20:30 - 21:30)',
    sectionId: 'commute_home_fri',
    daysOfWeek: [5],
    timeStart: '20:30',
    timeEnd: '21:30',
    order: 3,
  },

  // --- FINES DE SEMANA ---
  {
    id: 'task-sat-wake',
    title: 'Despertar temprano (05:00 - 06:00)',
    sectionId: 'weekend_morning',
    daysOfWeek: [6],
    timeStart: '05:00',
    order: 1,
  },
  {
    id: 'task-sun-wake',
    title: 'Despertar dominical (~06:00)',
    sectionId: 'weekend_morning',
    daysOfWeek: [0],
    timeStart: '06:00',
    order: 1,
  },

  // --- CIERRE DE JORNADA (DIARIO) ---
  {
    id: 'task-night-sleep',
    title: 'Rutina de noche y descanso (23:00 - 00:00)',
    sectionId: 'wind_down',
    daysOfWeek: [], // Aplica todos los días
    timeStart: '23:00',
    timeEnd: '00:00',
    order: 99,
  },
]);
