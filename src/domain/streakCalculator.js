/**
 * @module domain/streakCalculator
 * Algoritmo de **racha resiliente**: funciones puras, deterministas y sin
 * dependencias del DOM ni del reloj (todas las fechas entran por parámetro),
 * de modo que el módulo es testeable en Node y reproducible bit a bit.
 *
 * ## Formulación
 *
 * Para un día `d` con `n_d` tareas computables y `c_d` completadas:
 *
 *     r_d = c_d / n_d ∈ [0, 1]            (completionRate)
 *
 * Clasificación ω_d con umbrales τ_s = 0.8 y τ_p = 0.5:
 *
 *     ω_d = VOID     si n_d = 0
 *     ω_d = SUCCESS  si r_d ≥ τ_s
 *     ω_d = PARTIAL  si τ_p ≤ r_d < τ_s
 *     ω_d = FAIL     si r_d < τ_p
 *
 * Transición de racha S_d (con escudos E_d ∈ [0, 3]):
 *
 *     SUCCESS → S_d = S_{d-1} + 1
 *               E_d = min(3, E_{d-1} + 1) si S_d ≡ 0 (mod 7)
 *     PARTIAL → S_d = S_{d-1}                        (gracia, no incrementa)
 *     FAIL    → S_d = S_{d-1}, E_d = E_{d-1} − 1     si E_{d-1} > 0
 *               S_d = 0                              en caso contrario
 *     VOID    → sin cambios
 *
 * Consistencia ponderada (EWMA sobre ventana W = 14, α = 2/(W+1)):
 *
 *     C_d = α · 100·r_d + (1 − α) · C_{d-1}      (C inicial = 100·r_{d0})
 *
 * El EWMA da a la actividad reciente peso dominante sin descartar el
 * histórico, y se salta los días VOID para no diluir el score con días en los
 * que no había nada que hacer.
 */

import { DAY_OUTCOME, STREAK_TRANSITION, STREAK_CONFIG } from '../core/constants.js';
import { addDays, diffDays, assertDateKey } from '../core/dateUtils.js';

/**
 * @typedef {Object} StreakState
 * @property {number} currentStreak            Racha continua en días enteros.
 * @property {number} bestStreak               Máximo histórico alcanzado.
 * @property {number} shieldsAvailable         Escudos acumulados (entero, máx 3).
 * @property {number} shieldsUsedTotal         Total histórico de escudos consumidos.
 * @property {number} weightedConsistencyScore Puntuación flotante (0.0–100.0).
 * @property {string|null} lastEvaluatedDate   Última fecha procesada (YYYY-MM-DD).
 */

/**
 * @typedef {Object} DayEvaluation
 * @property {string} date
 * @property {keyof DAY_OUTCOME} outcome
 * @property {keyof STREAK_TRANSITION} transition
 * @property {number} completionRate
 * @property {boolean} shieldConsumed
 * @property {boolean} shieldEarned
 * @property {number} streakAfter
 */

/**
 * Clasifica un día a partir de su log.
 * @param {{totalActiveTasks:number, completedCount:number, completionRate:number, entries?:Object}} log
 * @param {typeof STREAK_CONFIG} [config]
 * @returns {string} valor de {@link DAY_OUTCOME}
 */
export function classifyDay(log, config = STREAK_CONFIG) {
  const computable = computableTasks(log);
  if (computable <= 0) return DAY_OUTCOME.VOID;
  const rate = effectiveRate(log, computable);
  if (rate >= config.THRESHOLD_SUCCESS) return DAY_OUTCOME.SUCCESS;
  if (rate >= config.THRESHOLD_PARTIAL) return DAY_OUTCOME.PARTIAL;
  return DAY_OUTCOME.FAIL;
}

/**
 * Tareas que realmente cuentan para el ratio (activas menos dispensadas).
 * @param {{totalActiveTasks:number, entries?:Object}} log
 * @returns {number}
 */
export function computableTasks(log) {
  const total = Number(log?.totalActiveTasks ?? 0);
  if (!Number.isFinite(total) || total <= 0) return 0;
  const skipped = log?.entries
    ? Object.values(log.entries).filter((entry) => entry?.skipped).length
    : 0;
  return Math.max(0, total - skipped);
}

/**
 * Ratio de cumplimiento efectivo, recalculado desde los agregados.
 * @param {{completedCount:number, completionRate?:number}} log
 * @param {number} [computable]
 * @returns {number} ∈ [0, 1]
 */
export function effectiveRate(log, computable = computableTasks(log)) {
  if (computable <= 0) return 0;
  const completed = Number(log?.completedCount ?? 0);
  if (!Number.isFinite(completed) || completed <= 0) return 0;
  return Math.min(1, completed / computable);
}

/**
 * Aplica un día ya cerrado sobre el estado de racha. Función pura.
 * @param {StreakState} state
 * @param {{date:string, totalActiveTasks:number, completedCount:number, completionRate:number, entries?:Object}} log
 * @param {typeof STREAK_CONFIG} [config]
 * @returns {{state: StreakState, evaluation: DayEvaluation}}
 */
export function applyDay(state, log, config = STREAK_CONFIG) {
  assertDateKey(log.date);
  const outcome = classifyDay(log, config);
  const rate = effectiveRate(log);

  let { currentStreak, bestStreak, shieldsAvailable, shieldsUsedTotal, weightedConsistencyScore } = state;
  let transition = STREAK_TRANSITION.SKIPPED_VOID;
  let shieldConsumed = false;
  let shieldEarned = false;

  switch (outcome) {
    case DAY_OUTCOME.SUCCESS: {
      currentStreak += 1;
      transition = STREAK_TRANSITION.EXTENDED;
      if (currentStreak % config.SHIELD_EARN_INTERVAL === 0 && shieldsAvailable < config.MAX_SHIELDS) {
        shieldsAvailable += 1;
        shieldEarned = true;
      }
      break;
    }
    case DAY_OUTCOME.PARTIAL: {
      transition = STREAK_TRANSITION.PRESERVED_PARTIAL;
      break;
    }
    case DAY_OUTCOME.FAIL: {
      if (shieldsAvailable > 0) {
        shieldsAvailable -= 1;
        shieldsUsedTotal += 1;
        shieldConsumed = true;
        transition = STREAK_TRANSITION.PRESERVED_BY_SHIELD;
      } else {
        currentStreak = 0;
        transition = STREAK_TRANSITION.BROKEN;
      }
      break;
    }
    default:
      break; // VOID: estado intacto salvo lastEvaluatedDate.
  }

  bestStreak = Math.max(bestStreak, currentStreak);
  if (outcome !== DAY_OUTCOME.VOID) {
    weightedConsistencyScore = nextConsistencyScore(weightedConsistencyScore, rate, config, {
      isFirstSample: state.lastEvaluatedDate === null,
    });
  }

  return {
    state: {
      currentStreak,
      bestStreak,
      shieldsAvailable,
      shieldsUsedTotal,
      weightedConsistencyScore,
      lastEvaluatedDate: log.date,
    },
    evaluation: {
      date: log.date,
      outcome,
      transition,
      completionRate: rate,
      shieldConsumed,
      shieldEarned,
      streakAfter: currentStreak,
    },
  };
}

/**
 * EWMA de consistencia.
 * @param {number} previous     C_{d-1} ∈ [0, 100]
 * @param {number} rate         r_d ∈ [0, 1]
 * @param {typeof STREAK_CONFIG} [config]
 * @param {{isFirstSample?: boolean}} [options]
 * @returns {number} C_d redondeado a 2 decimales.
 */
export function nextConsistencyScore(previous, rate, config = STREAK_CONFIG, options = {}) {
  const sample = Math.min(100, Math.max(0, rate * 100));
  if (options.isFirstSample) return round2(sample);
  const alpha = 2 / (config.CONSISTENCY_WINDOW + 1);
  const value = alpha * sample + (1 - alpha) * (Number.isFinite(previous) ? previous : 0);
  return round2(Math.min(100, Math.max(0, value)));
}

/**
 * Reconcilia todos los días transcurridos entre `lastEvaluatedDate` y
 * `throughDate` (excluido). Un día sin log se trata como FAIL con `r = 0`
 * cuando había tareas activas, y como VOID cuando no las había: así una
 * app cerrada durante el fin de semana consume escudos en lugar de mentir.
 *
 * @param {StreakState} state
 * @param {Object.<string, {date:string,totalActiveTasks:number,completedCount:number,completionRate:number,entries?:Object}>} logsByDate
 * @param {string} throughDate   Día activo (no se evalúa: aún está abierto).
 * @param {{
 *   defaultActiveTasks?: number,
 *   activeTasksFor?: (date: string) => number,
 *   config?: typeof STREAK_CONFIG,
 * }} [options]
 *   `activeTasksFor` permite que el divisor dependa del día: con una agenda
 *   semanal, un sábado sin tareas no es lo mismo que un martes con ocho.
 * @returns {{state: StreakState, evaluations: DayEvaluation[], truncated: boolean}}
 */
export function reconcile(state, logsByDate, throughDate, options = {}) {
  assertDateKey(throughDate);
  const config = options.config ?? STREAK_CONFIG;
  const fallbackActiveTasks = Math.max(0, Math.trunc(options.defaultActiveTasks ?? 0));
  const activeTasksFor = typeof options.activeTasksFor === 'function'
    ? (date) => Math.max(0, Math.trunc(options.activeTasksFor(date)))
    : () => fallbackActiveTasks;

  let working = { ...state };
  /** @type {DayEvaluation[]} */
  const evaluations = [];

  if (working.lastEvaluatedDate === null) {
    // Primera ejecución: no hay pasado que juzgar, se ancla al día anterior.
    return { state: { ...working, lastEvaluatedDate: addDays(throughDate, -1) }, evaluations, truncated: false };
  }

  const gap = diffDays(working.lastEvaluatedDate, throughDate);
  if (gap <= 1) return { state: working, evaluations, truncated: false };

  const pending = gap - 1; // días completos entre el último evaluado y hoy
  const truncated = pending > config.MAX_RECONCILE_DAYS;
  const startOffset = truncated ? pending - config.MAX_RECONCILE_DAYS : 0;
  if (truncated) {
    // Hueco absurdo (reloj alterado o años de inactividad): la racha no sobrevive.
    working = { ...working, currentStreak: 0 };
  }

  let cursor = addDays(working.lastEvaluatedDate, 1 + startOffset);
  while (diffDays(cursor, throughDate) > 0) {
    const log = logsByDate[cursor] ?? {
      date: cursor,
      entries: {},
      totalActiveTasks: activeTasksFor(cursor),
      completedCount: 0,
      completionRate: 0,
    };
    const result = applyDay(working, log, config);
    working = result.state;
    evaluations.push(result.evaluation);
    cursor = addDays(cursor, 1);
  }

  return { state: working, evaluations, truncated };
}

/**
 * Proyección en vivo del día en curso (no muta el estado persistido).
 * Responde a "¿qué pasa con mi racha si el día terminase ahora?".
 * @param {StreakState} state
 * @param {{totalActiveTasks:number, completedCount:number, completionRate:number, entries?:Object}} todayLog
 * @param {typeof STREAK_CONFIG} [config]
 * @returns {{outcome:string, projectedStreak:number, remainingForSuccess:number, atRisk:boolean}}
 */
export function projectToday(state, todayLog, config = STREAK_CONFIG) {
  const computable = computableTasks(todayLog);
  const outcome = classifyDay(todayLog, config);
  const needed = computable === 0 ? 0 : Math.ceil(computable * config.THRESHOLD_SUCCESS);
  const remainingForSuccess = Math.max(0, needed - Number(todayLog?.completedCount ?? 0));

  let projectedStreak = state.currentStreak;
  if (outcome === DAY_OUTCOME.SUCCESS) projectedStreak += 1;
  else if (outcome === DAY_OUTCOME.FAIL && state.shieldsAvailable === 0) projectedStreak = 0;

  return {
    outcome,
    projectedStreak,
    remainingForSuccess,
    atRisk: outcome === DAY_OUTCOME.FAIL && state.currentStreak > 0,
  };
}

/**
 * Días que faltan para ganar el próximo escudo.
 * @param {StreakState} state
 * @param {typeof STREAK_CONFIG} [config]
 * @returns {number|null} `null` si ya se alcanzó el máximo.
 */
export function daysToNextShield(state, config = STREAK_CONFIG) {
  if (state.shieldsAvailable >= config.MAX_SHIELDS) return null;
  const remainder = state.currentStreak % config.SHIELD_EARN_INTERVAL;
  return config.SHIELD_EARN_INTERVAL - remainder;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
