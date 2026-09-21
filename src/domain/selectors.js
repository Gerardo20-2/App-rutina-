/**
 * @module domain/selectors
 * Derivaciones puras del estado. Concentrarlas aquí evita que los componentes
 * de UI recalculen agregados con criterios distintos (la causa habitual de que
 * la cabecera y la lista muestren cifras que no coinciden).
 */

import { DAY_OUTCOME } from '../core/constants.js';
import { classifyDay, computableTasks, projectToday } from './streakCalculator.js';
import { resolveSchedule, tasksForDay, describeDays } from './timeBlockService.js';

/**
 * Agrupa las tareas aplicables al día en sus bloques horarios, en el orden de
 * la agenda. Los bloques sin tareas ese día no se renderizan.
 *
 * @param {import('./taskValidator.js').TaskDefinition[]} tasks todas las tareas activas.
 * @param {import('./taskValidator.js').DailyLog} log
 * @param {{
 *   date?: string|Date,
 *   schedule?: import('./timeBlockService.js').ResolvedBlock[],
 *   activeBlockId?: string|null,
 * }} [context]
 * @returns {Array<Object>} grupos listos para renderizar.
 */
export function groupByBlock(tasks, log, context = {}) {
  const date = context.date ?? new Date();
  const schedule = context.schedule ?? resolveSchedule(date);
  const applicable = tasksForDay(tasks, date);

  return schedule
    .map((block) => {
      const items = applicable
        .filter((task) => task.sectionId === block.id)
        .map((task) => ({
          ...task,
          record: log.entries[task.id] ?? { completed: false, completedAt: null, skipped: false },
          daysLabel: describeDays(task.daysOfWeek),
        }));
      return {
        ...block,
        isActive: block.id === context.activeBlockId,
        tasks: items,
        completed: items.filter((item) => item.record.completed).length,
        skipped: items.filter((item) => item.record.skipped).length,
      };
    })
    .filter((group) => group.tasks.length > 0);
}

/**
 * Progreso del día activo.
 * @param {import('./taskValidator.js').DailyLog} log
 * @returns {{completed:number, total:number, computable:number, skipped:number, ratio:number, percent:number, outcome:string}}
 */
export function computeProgress(log) {
  const computable = computableTasks(log);
  const skipped = Object.values(log?.entries ?? {}).filter((entry) => entry?.skipped).length;
  const completed = Number(log?.completedCount ?? 0);
  const ratio = computable === 0 ? 0 : Math.min(1, completed / computable);
  return {
    completed,
    total: Number(log?.totalActiveTasks ?? 0),
    computable,
    skipped,
    ratio,
    percent: Math.round(ratio * 100),
    outcome: classifyDay(log),
  };
}

/**
 * Datos de cabecera: progreso, proyección de racha y bloque en curso.
 * @param {import('../core/store.js').AppState} state
 */
export function headerModel(state) {
  const progress = computeProgress(state.log);
  const projection = projectToday(state.streak, state.log);
  const activeBlock = (state.schedule ?? []).find((block) => block.id === state.ui.activeBlockId) ?? null;

  return {
    date: state.today,
    progress,
    projection,
    streak: state.streak,
    activeBlock,
    allDone: progress.computable > 0 && progress.completed >= progress.computable,
    isVoid: progress.outcome === DAY_OUTCOME.VOID,
  };
}

/**
 * Convierte una lista de logs en el resumen indexado por fecha que consume el
 * heatmap.
 * @param {import('./taskValidator.js').DailyLog[]} logs
 * @returns {Object.<string, {completionRate:number, completedCount:number, totalActiveTasks:number}>}
 */
export function buildHistory(logs) {
  /** @type {Object.<string, *>} */
  const history = {};
  for (const log of logs) {
    history[log.date] = {
      completionRate: log.completionRate,
      completedCount: log.completedCount,
      totalActiveTasks: log.totalActiveTasks,
    };
  }
  return history;
}

/**
 * Minutos estimados que quedan hoy, contando sólo tareas aplicables.
 * @param {import('./taskValidator.js').TaskDefinition[]} tasks
 * @param {import('./taskValidator.js').DailyLog} log
 * @param {string|Date} [date]
 * @returns {number}
 */
export function remainingMinutes(tasks, log, date = new Date()) {
  return tasksForDay(tasks, date).reduce((sum, task) => {
    const record = log.entries[task.id];
    if (record?.completed || record?.skipped) return sum;
    return sum + (task.estimatedMinutes || 0);
  }, 0);
}
