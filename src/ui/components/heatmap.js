/**
 * @module ui/components/heatmap
 * Mapa de calor de consistencia dibujado en `<canvas>`.
 *
 * Se usa canvas y no ~140 nodos DOM porque el heatmap se redibuja con cada
 * cambio de estado y en móviles de gama baja el coste de layout de esa rejilla
 * es visible; un canvas se repinta en una sola operación.
 *
 * Accesibilidad: el canvas es decorativo (`aria-hidden`) y va acompañado de
 * una tabla textual equivalente, oculta visualmente pero anunciable, más una
 * línea de detalle que se actualiza al tocar un día.
 */

import { h } from '../dom.js';
import { LIMITS } from '../../core/constants.js';
import { toDateKey, addDays, weekdayIndex, formatLongDate, diffDays } from '../../core/dateUtils.js';

const WEEKS = LIMITS.HEATMAP_WEEKS;
const DAYS_PER_WEEK = 7;
const GAP = 3;
const RADIUS = 2.5;

export function createHeatmap() {
  const canvas = h('canvas', { class: 'heatmap__canvas', 'aria-hidden': 'true' });
  const detail = h('p', { class: 'heatmap__detail', 'aria-live': 'polite' });
  const summary = h('p', { class: 'sr-only' });
  const legend = h('div', { class: 'heatmap__legend', 'aria-hidden': 'true' }, [
    h('span', { text: 'Menos' }),
    ...[0, 1, 2, 3, 4].map((level) => h('i', { class: 'heatmap__swatch', dataset: { level: String(level) } })),
    h('span', { text: 'Más' }),
  ]);

  const el = h('section', { class: 'heatmap card', 'aria-labelledby': 'heatmap-title' }, [
    h('div', { class: 'card__head' }, [
      h('h2', { class: 'card__title', id: 'heatmap-title', text: 'Consistencia' }),
      h('span', { class: 'card__hint', text: `${WEEKS} semanas` }),
    ]),
    canvas,
    legend,
    detail,
    summary,
  ]);

  /** @type {{date: string, rate: number|null, x: number, y: number, w: number, h: number}[]} */
  let cells = [];
  /** @type {import('../../core/store.js').AppState|null} */
  let lastState = null;
  let resizeObserver = null;

  function update(state) {
    lastState = state;
    draw();
    const days = Object.values(state.history ?? {});
    const active = days.filter((d) => d && d.totalActiveTasks > 0);
    const perfect = active.filter((d) => d.completionRate >= 1).length;
    summary.textContent = `Historial de ${active.length} días registrados, ${perfect} completados al 100 %.`;
  }

  function draw() {
    if (!lastState) return;
    const width = el.clientWidth || canvas.clientWidth || 320;
    if (width <= 0) return;

    const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
    const cell = Math.max(6, Math.floor((width - (WEEKS - 1) * GAP) / WEEKS));
    const cssWidth = WEEKS * cell + (WEEKS - 1) * GAP;
    const cssHeight = DAYS_PER_WEEK * cell + (DAYS_PER_WEEK - 1) * GAP;

    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const palette = readPalette();
    const today = lastState.today || toDateKey();
    // La última columna termina en el día de hoy; la rejilla se alinea a la
    // semana (lunes arriba), de ahí el relleno inicial.
    const lastColumnOffset = weekdayIndex(today);
    const start = addDays(today, -((WEEKS - 1) * DAYS_PER_WEEK + lastColumnOffset));

    cells = [];
    for (let week = 0; week < WEEKS; week += 1) {
      for (let day = 0; day < DAYS_PER_WEEK; day += 1) {
        const date = addDays(start, week * DAYS_PER_WEEK + day);
        if (diffDays(date, today) < 0) continue; // futuro: no se pinta
        const entry = lastState.history?.[date];
        const rate = entry && entry.totalActiveTasks > 0 ? entry.completionRate : null;
        const x = week * (cell + GAP);
        const y = day * (cell + GAP);

        ctx.fillStyle = palette[levelFor(rate)];
        roundRect(ctx, x, y, cell, cell, RADIUS);
        ctx.fill();

        if (date === today) {
          ctx.strokeStyle = palette.today;
          ctx.lineWidth = 1.5;
          roundRect(ctx, x + 0.75, y + 0.75, cell - 1.5, cell - 1.5, RADIUS);
          ctx.stroke();
        }
        cells.push({ date, rate, x, y, w: cell, h: cell });
      }
    }
  }

  /** @param {PointerEvent} event */
  function inspect(event) {
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const hit = cells.find((c) => px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h);
    if (!hit) return;
    detail.textContent = hit.rate === null
      ? `${capitalize(formatLongDate(hit.date))}: sin registro`
      : `${capitalize(formatLongDate(hit.date))}: ${Math.round(hit.rate * 100)} % completado`;
  }

  canvas.addEventListener('pointerdown', inspect);
  canvas.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'mouse') inspect(event);
  });

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => draw());
    resizeObserver.observe(el);
  } else if (typeof window !== 'undefined') {
    window.addEventListener('resize', draw);
  }

  const themeQuery = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  const onThemeChange = () => draw();
  themeQuery?.addEventListener?.('change', onThemeChange);

  return {
    el,
    update,
    redraw: draw,
    destroy() {
      resizeObserver?.disconnect();
      themeQuery?.removeEventListener?.('change', onThemeChange);
      if (typeof window !== 'undefined') window.removeEventListener('resize', draw);
    },
  };
}

/**
 * Nivel discreto de intensidad.
 * @param {number|null} rate
 * @returns {0|1|2|3|4}
 */
export function levelFor(rate) {
  if (rate === null || rate === undefined) return 0;
  if (rate <= 0) return 1;
  if (rate < 0.5) return 2;
  if (rate < 0.8) return 3;
  return 4;
}

/**
 * Los colores viven en CSS (`--heat-0` … `--heat-4`) para que el tema claro y
 * el oscuro se resuelvan en una sola fuente de verdad.
 */
function readPalette() {
  const styles = getComputedStyle(document.documentElement);
  const read = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
  return {
    0: read('--heat-0', '#e9eef5'),
    1: read('--heat-1', '#cfe0d3'),
    2: read('--heat-2', '#8fd0a4'),
    3: read('--heat-3', '#4fb277'),
    4: read('--heat-4', '#22814b'),
    today: read('--heat-today', '#1f2933'),
  };
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, radius);
    return;
  }
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
