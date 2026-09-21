/**
 * @module domain/selectors
 * Derivaciones puras del estado. Concentrarlas aquí evita que los componentes
 * de UI recalculen agregados con criterios distintos (la causa habitual de que
 * la cabecera y la lista muestren cifras que no coinciden).
 */

import { SECTION_ORDER, SECTION_META, DAY_OUTCOME } from '../core/constants.js';
import { classifyDay, computableTasks, projectToday } from './streakCalculator.js';

/**
 * Agrupa tareas activas por bloque del día, descartando bloques vacíos.
 * @param {import('./taskValidator.js').TaskDefinition[]} tasks
 * @param {import('./taskValidator.js').DailyLog} log
 * @returns {Array<{section:string, label:string, icon:string, range:string, tasks:Array<*>, completed:number}>}
 */
export function groupBySection(tasks, log) {
  return SECTION_ORDER.map((section) => {
    const items = tasks
      .filter((task) => task.section === section)
      .map((task) => ({
        ...task,
        record: log.entries[task.id] ?? { completed: false, completedAt: null, skipped: false },
      }));
    return {
      section,
      ...SECTION_META[section],
      tasks: items,
      completed: items.filter((item) => item.record.completed).length,
    };
  }).filter((group) => group.tasks.length > 0);
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
 * Datos de cabecera: progreso + proyección de racha.
 * @param {import('../core/store.js').AppState} state
 */
export function headerModel(state) {
  const progress = computeProgress(state.log);
  const projection = projectToday(state.streak, state.log);
  return {
    date: state.today,
    progress,
    projection,
    streak: state.streak,
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
 * Minutos estimados restantes del día.
 * @param {import('./taskValidator.js').TaskDefinition[]} tasks
 * @param {import('./taskValidator.js').DailyLog} log
 * @returns {number}
 */
export function remainingMinutes(tasks, log) {
  return tasks.reduce((sum, task) => {
    const record = log.entries[task.id];
    if (record?.completed || record?.skipped) return sum;
    return sum + (task.estimatedMinutes || 0);
  }, 0);
}
