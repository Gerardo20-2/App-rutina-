/**
 * @module domain/dayResetService
 * Detección de medianoche y reinicio automático del día.
 *
 * ## Máquina de estados
 *
 *   IDLE ──start()──▶ SCHEDULED ──(timer | visibilitychange | focus | tick)──▶ EVALUATING
 *   EVALUATING ──cierra el día abierto──▶ RECONCILING ──aplica días perdidos──▶ SCHEDULED
 *   EVALUATING|RECONCILING ──error──▶ ERROR ──reintento en el próximo disparo──▶ SCHEDULED
 *
 * ## Por qué no basta un `setTimeout` a medianoche
 *
 *  - Los temporizadores se congelan cuando la pestaña pasa a segundo plano o
 *    el dispositivo se suspende: al volver pueden dispararse tarde, o no
 *    dispararse.
 *  - El usuario puede cambiar el reloj o el huso horario.
 *  - Una PWA instalada puede permanecer abierta días enteros.
 *
 * Por eso la detección es **por comparación de clave de día**, y el temporizador
 * es sólo uno de cuatro disparadores: timer, `visibilitychange`, `focus` y un
 * tick de seguridad cada 30 s. Cualquiera de ellos converge al mismo resultado
 * porque `_rollover()` es idempotente respecto a la fecha.
 */

import { RESET_STATE, EVENTS, STREAK_CONFIG, LIMITS, SECURITY_CONFIG } from '../core/constants.js';
import { toDateKey, msUntilNextMidnight, diffDays, addDays } from '../core/dateUtils.js';
import { applyDay, reconcile } from './streakCalculator.js';
import { buildHistory } from './selectors.js';
import { countTasksForDay } from './timeBlockService.js';

/** Periodo del tick de seguridad (ms). */
const SAFETY_TICK_MS = 30_000;
/** Máximo de `setTimeout` estable entre navegadores (~24,8 días). */
const MAX_TIMEOUT_MS = 2_147_483_000;

export class DayResetService {
  /**
   * @param {{
   *   repository: import('../storage/repository.js').Repository,
   *   store: import('../core/store.js').Store,
   *   bus: import('../core/events.js').EventBus,
   *   now?: () => Date,
   * }} deps
   */
  constructor({ repository, store, bus, now = () => new Date() }) {
    this._repository = repository;
    this._store = store;
    this._bus = bus;
    this._now = now;

    /** @type {string} */
    this.state = RESET_STATE.IDLE;
    this._timerId = null;
    this._tickId = null;
    this._listeners = [];
    this._running = false;
    /** @type {Promise<void>|null} Serializa disparos concurrentes. */
    this._inFlight = null;
  }

  /** Arranca la vigilancia. Idempotente. */
  start() {
    if (this._running) return;
    this._running = true;

    const onWake = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void this.check('wake');
    };

    if (typeof document !== 'undefined') {
      const handler = () => onWake();
      document.addEventListener('visibilitychange', handler);
      this._listeners.push(() => document.removeEventListener('visibilitychange', handler));
    }
    if (typeof window !== 'undefined') {
      const focusHandler = () => onWake();
      window.addEventListener('focus', focusHandler);
      window.addEventListener('pageshow', focusHandler);
      this._listeners.push(() => {
        window.removeEventListener('focus', focusHandler);
        window.removeEventListener('pageshow', focusHandler);
      });
    }

    this._tickId = setInterval(() => void this.check('tick'), SAFETY_TICK_MS);
    this._schedule();
  }

  /** Detiene temporizadores y listeners. */
  stop() {
    this._running = false;
    if (this._timerId !== null) clearTimeout(this._timerId);
    if (this._tickId !== null) clearInterval(this._tickId);
    this._timerId = null;
    this._tickId = null;
    for (const dispose of this._listeners.splice(0)) dispose();
    this.state = RESET_STATE.IDLE;
  }

  /**
   * Comprueba si cambió el día y, en tal caso, ejecuta el corte.
   * Las llamadas concurrentes comparten la misma promesa.
   * @param {string} [reason] origen del disparo (telemetría/debug).
   * @returns {Promise<boolean>} `true` si hubo cambio de día.
   */
  async check(reason = 'manual') {
    if (this._inFlight) {
      await this._inFlight;
      return false;
    }
    const today = toDateKey(this._now());
    const state = this._store.getState();
    const lastEvaluated = state.streak.lastEvaluatedDate;

    // Desincronización de reloj: el dispositivo dice que hoy es anterior al
    // último día ya evaluado. Puede ser un viaje al oeste cruzando la línea de
    // cambio de fecha, una corrección NTP agresiva o un reloj puesto a mano.
    // Evaluar ese "pasado" reescribiría logs cerrados y reiniciaría rachas
    // legítimas, así que el cálculo diario se congela hasta que el reloj
    // vuelva a ser coherente. El usuario sigue pudiendo marcar tareas: lo que
    // se detiene es el cierre de días, no la aplicación.
    if (lastEvaluated !== null && diffDays(lastEvaluated, today) < 0) {
      this._freeze({ today, lastEvaluated, reason });
      this._schedule();
      return false;
    }
    if (state.ui.clockDesynced) this._thaw();

    const activeDay = state.today;
    if (today === activeDay) {
      this._schedule();
      return false;
    }

    this._inFlight = this._rollover(today, activeDay, reason)
      .catch((error) => {
        this.state = RESET_STATE.ERROR;
        console.error('[DayResetService] corte de día fallido', error);
        this._bus.emit(EVENTS.ERROR, { scope: 'day-reset', error });
      })
      .finally(() => {
        this._inFlight = null;
        this._schedule();
      });

    await this._inFlight;
    return true;
  }

  /**
   * Cierra `previousDay`, reconcilia los días intermedios y abre `today`.
   * @param {string} today
   * @param {string} previousDay
   * @param {string} reason
   */
  async _rollover(today, previousDay, reason) {
    this.state = RESET_STATE.EVALUATING;

    // Reloj hacia atrás (cambio manual o corrección NTP agresiva): no se
    // reevalúa el pasado, sólo se reapunta el día activo y se recarga lo
    // persistido para que la vista no muestre una racha obsoleta.
    if (diffDays(previousDay, today) < 0) {
      console.warn(`[DayResetService] salto de reloj hacia atrás ${previousDay} → ${today}`);
      await this._openDay(today);
      const persisted = await this._repository.getStreak();
      this._store.setState({ streak: persisted, history: await this._loadHistory(today) });
      this.state = RESET_STATE.IDLE;
      this._bus.emit(EVENTS.DAY_ROLLED, {
        from: previousDay, to: today, evaluations: [], streak: persisted, reason,
      });
      return;
    }

    // Auditoría de integridad ANTES de leer nada para la racha: un registro
    // manipulado desde el último arranque no debe llegar a puntuar.
    await this.auditIntegrity(previousDay, reason);

    const tasks = await this._repository.listTasks();
    let streak = await this._repository.getStreak();
    // El divisor de cada día lo fija su propia agenda: lo que aplicaba ese día
    // de la semana, no el total de tareas del usuario.
    const activeTasksFor = (date) => countTasksForDay(tasks, date);

    // 1. Cierre del día anterior con los datos realmente persistidos.
    const previousLog = await this._repository.getLog(previousDay);
    /** @type {import('./streakCalculator.js').DayEvaluation[]} */
    const evaluations = [];

    // Un log sin firma válida no se evalúa: se cierra, y el tramo de
    // reconciliación lo trata como un día sin registro.
    if (previousLog && !previousLog.closed && previousLog.unverified) {
      await this._repository.saveLog({ ...previousLog, closed: true });
    } else if (previousLog && !previousLog.closed) {
      const closed = await this._repository.saveLog({ ...previousLog, closed: true });
      if (streak.lastEvaluatedDate === null || diffDays(streak.lastEvaluatedDate, previousDay) > 0) {
        // Días huérfanos anteriores al que cerramos ahora.
        this.state = RESET_STATE.RECONCILING;
        const gapResult = await this._reconcileGap(streak, previousDay, activeTasksFor);
        streak = gapResult.state;
        evaluations.push(...gapResult.evaluations);

        const applied = applyDay(streak, closed, STREAK_CONFIG);
        streak = applied.state;
        evaluations.push(applied.evaluation);
      }
    }

    // 2. Días sin registro alguno (app cerrada) hasta ayer inclusive.
    this.state = RESET_STATE.RECONCILING;
    const tailResult = await this._reconcileGap(streak, today, activeTasksFor);
    streak = tailResult.state;
    evaluations.push(...tailResult.evaluations);

    streak = await this._repository.saveStreak(streak);

    // 3. Apertura del nuevo día.
    await this._openDay(today, activeTasksFor(today));

    const history = await this._loadHistory(today);
    this._store.setState({ streak, history });

    // El estado vuelve a IDLE: sólo `_schedule()` (y sólo si el servicio está
    // arrancado) puede declarar que hay un temporizador armado.
    this.state = RESET_STATE.IDLE;
    this._bus.emit(EVENTS.DAY_ROLLED, { from: previousDay, to: today, evaluations, streak, reason });
    this._bus.emit(EVENTS.STREAK_UPDATED, { streak, evaluations });
    const shieldEvent = evaluations.find((e) => e.shieldConsumed);
    if (shieldEvent) this._bus.emit(EVENTS.SHIELD_CONSUMED, { date: shieldEvent.date, streak });
  }

  /**
   * @param {import('./streakCalculator.js').StreakState} streak
   * @param {string} throughDate
   * @param {(date: string) => number} activeTasksFor
   */
  async _reconcileGap(streak, throughDate, activeTasksFor) {
    if (streak.lastEvaluatedDate === null) {
      return { state: { ...streak, lastEvaluatedDate: addDays(throughDate, -1) }, evaluations: [] };
    }
    const span = diffDays(streak.lastEvaluatedDate, throughDate);
    if (span <= 1) return { state: streak, evaluations: [] };

    const logs = await this._repository.listLogs(addDays(streak.lastEvaluatedDate, 1), addDays(throughDate, -1));
    /** @type {Object.<string, *>} */
    const byDate = {};
    for (const log of logs) {
      if (!log.unverified) byDate[log.date] = log;
    }

    return reconcile(streak, byDate, throughDate, {
      activeTasksFor,
      config: STREAK_CONFIG,
    });
  }

  /**
   * Verifica las firmas HMAC de la ventana reciente (ver
   * `Repository.auditIntegrity`) y avisa si encuentra manipulación. Si la
   * racha se reconstruyó, el store se actualiza con la nueva.
   * @param {string} [activeDay] día abierto (no evaluado); por defecto, el del store.
   * @param {string} [reason]
   * @returns {Promise<Awaited<ReturnType<import('../storage/repository.js').Repository['auditIntegrity']>>>}
   */
  async auditIntegrity(activeDay = this._store.getState().today, reason = 'manual') {
    const report = await this._repository.auditIntegrity({
      days: SECURITY_CONFIG.INTEGRITY_AUDIT_DAYS,
      today: activeDay,
    });
    if (report.status !== 'tampered') return report;

    const patch = {};
    if (report.streakTampered) patch.streak = await this._repository.getStreak();
    const { log } = this._store.getState();
    if (log && report.tamperedDates.includes(log.date)) patch.log = await this._repository.getLog(log.date);
    if (Object.keys(patch).length > 0) this._store.setState(patch);

    console.warn('[DayResetService] integridad: registros manipulados', report);
    this._bus.emit(EVENTS.INTEGRITY_VIOLATION, { ...report, reason });
    return report;
  }

  /**
   * @param {string} date
   * @param {number} [taskCount]
   */
  async _openDay(date, taskCount) {
    const applicable = taskCount === undefined
      ? countTasksForDay(await this._repository.listTasks(), date)
      : taskCount;
    const log = await this._repository.ensureLog(date, applicable);
    this._store.setState({ today: date, log });
  }

  /** @param {string} today @returns {Promise<Object>} resumen para el heatmap. */
  async _loadHistory(today) {
    return buildHistory(await this._repository.recentLogs(LIMITS.HEATMAP_WEEKS * 7, today));
  }

  /**
   * Congela el cálculo diario tras detectar un reloj retrasado. Idempotente:
   * los avisos y el evento se emiten una sola vez por episodio.
   * @param {{today: string, lastEvaluated: string, reason: string}} context
   */
  _freeze({ today, lastEvaluated, reason }) {
    this.state = RESET_STATE.FROZEN;
    if (this._store.getState().ui.clockDesynced) return;

    console.warn(
      `[DayResetService] reloj desincronizado: hoy (${today}) es anterior al último día `
      + `evaluado (${lastEvaluated}). Cálculo diario congelado; no se alteran logs ni rachas.`,
    );
    this._store.patch('ui', { clockDesynced: true });
    this._bus.emit(EVENTS.CLOCK_DESYNC, { frozen: true, today, lastEvaluated, reason });
  }

  /** Reanuda el cálculo diario cuando el reloj vuelve a ser coherente. */
  _thaw() {
    this._store.patch('ui', { clockDesynced: false });
    this.state = RESET_STATE.IDLE;
    this._bus.emit(EVENTS.CLOCK_DESYNC, { frozen: false });
  }

  /** Reprograma el temporizador de medianoche. */
  _schedule() {
    if (!this._running) return;
    if (this._timerId !== null) clearTimeout(this._timerId);
    const delay = Math.min(MAX_TIMEOUT_MS, msUntilNextMidnight(this._now()));
    this._timerId = setTimeout(() => void this.check('timer'), delay);
    // ERROR y FROZEN son estados que describen una condición pendiente: el
    // temporizador se rearma igual, pero no los pisa.
    if (this.state !== RESET_STATE.ERROR && this.state !== RESET_STATE.FROZEN) {
      this.state = RESET_STATE.SCHEDULED;
    }
  }
}
