/**
 * Prueba de humo end-to-end sobre Chromium.
 *
 * Cubre lo que las pruebas de dominio no pueden: render real, ergonomía de la
 * zona del pulgar, gestos, hojas deslizantes, IndexedDB del navegador, canvas
 * del heatmap, alcance del Service Worker con rutas relativas y arranque sin
 * conexión.
 *
 * Playwright NO es una dependencia del proyecto: esta prueba es opcional y no
 * corre en CI. Para ejecutarla hace falta tenerlo disponible:
 *
 *     npm install --no-save playwright && npx playwright install chromium
 *     node tests/e2e/smoke.mjs
 *
 * El servidor estático se levanta aquí mismo con `node:http`. Sirve la app
 * bajo un **subdirectorio** (`/App-rutina-/`) a propósito: es como la publica
 * GitHub Pages, y es justo donde una ruta absoluta se rompería.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import('playwright');
// La prueba comparte el motor de agenda con la aplicación: así las cifras
// esperadas se derivan del mismo sitio y no hay que fijarlas a mano por día.
const { tasksForDay, activeBlockId } = await import('../../src/domain/timeBlockService.js');
const { INITIAL_TASKS } = await import('../../src/storage/seedData.js');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT ?? 8123);
/** Prefijo de despliegue, igual que en GitHub Pages. */
const BASE_PATH = '/App-rutina-/';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (!requested.startsWith(BASE_PATH)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('fuera del subdirectorio de despliegue');
    return;
  }
  const withinApp = requested.slice(BASE_PATH.length) || 'index.html';
  const relative = normalize(withinApp.endsWith('/') ? `${withinApp}index.html` : withinApp)
    .replace(/^(\.\.[/\\])+/, '');
  const filePath = join(ROOT, relative);
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
});

await new Promise((done) => server.listen(PORT, '127.0.0.1', done));
const BASE = `http://127.0.0.1:${PORT}${BASE_PATH}`;
console.log(`Sirviendo ${ROOT} en ${BASE}`);

/** @type {string[]} */
const errors = [];
const check = (condition, message) => {
  if (!condition) errors.push(message);
  return Boolean(condition);
};

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  hasTouch: true,
  isMobile: true,
  locale: 'es-ES',
});
const page = await context.newPage();
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`); });
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.header__title', { timeout: 10_000 });

  // ── 1. Arranque en frío: motor, semilla real y filtrado por día ────────
  const engine = await page.textContent('.settings__engine');
  console.log('motor de persistencia:', engine);
  check(engine === 'IndexedDB', `se esperaba IndexedDB, hay "${engine}"`);

  const hoy = new Date();
  const aplicables = tasksForDay(INITIAL_TASKS, hoy);
  const bloquesEsperados = new Set(aplicables.map((task) => task.sectionId));
  console.log(`hoy (día ${hoy.getDay()}) aplican ${aplicables.length} de ${INITIAL_TASKS.length} tareas`);

  const seeded = await page.locator('.task').count();
  const seededSections = await page.locator('.section').count();
  console.log('tareas renderizadas:', seeded, '· bloques:', seededSections);
  check(seeded === aplicables.length,
    `se esperaban ${aplicables.length} tareas del día, hay ${seeded}`);
  check(seededSections === bloquesEsperados.size,
    `se esperaban ${bloquesEsperados.size} bloques, hay ${seededSections}`);
  check(!(await page.locator('.empty').isVisible()), 'el estado vacío se muestra con tareas presentes');

  // Filtrado estricto: nada de otros días llega al DOM.
  const renderedIds = await page.locator('.task').evaluateAll(
    (nodes) => nodes.map((node) => node.dataset.id),
  );
  const permitidos = new Set(aplicables.map((task) => task.id));
  const intrusas = renderedIds.filter((id) => !permitidos.has(id));
  check(intrusas.length === 0, `tareas de otros días en el DOM: ${intrusas.join(', ')}`);

  const renderedBlocks = await page.locator('.section').evaluateAll(
    (nodes) => nodes.map((node) => node.dataset.section),
  );
  const bloquesIntrusos = renderedBlocks.filter((id) => !bloquesEsperados.has(id));
  check(bloquesIntrusos.length === 0, `bloques sin tareas en el DOM: ${bloquesIntrusos.join(', ')}`);

  // ── 1 bis. Bloque en curso: auto-enfoque y destacado ───────────────────
  const esperadoActivo = activeBlockId(hoy);
  const marcados = await page.locator('.section[data-active="true"]').evaluateAll(
    (nodes) => nodes.map((node) => node.dataset.section),
  );
  console.log('bloque en curso:', esperadoActivo ?? '(ninguno)', '· destacados:', marcados);
  check(marcados.length <= 1, `más de un bloque marcado como en curso: ${marcados.join(', ')}`);
  if (esperadoActivo && bloquesEsperados.has(esperadoActivo)) {
    check(marcados[0] === esperadoActivo, `se esperaba destacar ${esperadoActivo}`);
    check(await page.locator(`.section[data-section="${esperadoActivo}"]`).getAttribute('data-collapsed') === 'false',
      'el bloque en curso debe arrancar desplegado');
    check(await page.locator(`.section[data-section="${esperadoActivo}"] .section__badge`).isVisible(),
      'falta la etiqueta «Bloque en curso»');
  }

  // ── 2. Zona del pulgar: acciones abajo, cabecera pasiva ────────────────
  const ergonomics = await page.evaluate(() => {
    const bar = document.querySelector('.bar').getBoundingClientRect();
    const fab = document.querySelector('.fab').getBoundingClientRect();
    const header = document.querySelector('.header');
    const smallTargets = [...document.querySelectorAll(
      '.bar__btn, .fab, .task__edit, .section__toggle, .sheet__close',
    )]
      .filter((node) => node.offsetParent !== null)
      .map((node) => ({ cls: node.className, rect: node.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width < 48 || rect.height < 48)
      .map(({ cls, rect }) => `${cls} ${Math.round(rect.width)}×${Math.round(rect.height)}`);
    return {
      barBottom: Math.round(bar.bottom),
      barTop: Math.round(bar.top),
      viewport: window.innerHeight,
      fab: `${Math.round(fab.width)}×${Math.round(fab.height)}`,
      headerControls: header.querySelectorAll('button, a, input, select').length,
      smallTargets,
    };
  });
  console.log('ergonomía:', ergonomics);
  check(ergonomics.barBottom >= ergonomics.viewport - 1, 'la barra de acciones no está anclada al borde inferior');
  check(ergonomics.barTop > ergonomics.viewport * 0.75, 'la barra invade más del cuarto inferior de la pantalla');
  check(ergonomics.fab === '56×56', `el FAB mide ${ergonomics.fab}, se esperaban 56×56`);
  check(ergonomics.headerControls === 0, 'la cabecera contiene controles: debe ser zona de lectura pasiva');
  check(ergonomics.smallTargets.length === 0, `objetivos táctiles por debajo de 48 px: ${ergonomics.smallTargets.join(', ')}`);

  // ── 3. Bloques plegables: sólo el de la hora actual abierto ────────────
  const collapsed = await page.locator('.section[data-collapsed="true"]').count();
  console.log('bloques plegados al arrancar:', collapsed, 'de', seededSections);
  check(collapsed === seededSections - 1, `se esperaba un único bloque abierto, hay ${seededSections - collapsed}`);

  // Los localizadores se anclan al nombre del bloque: `[data-collapsed="true"]`
  // deja de coincidir en cuanto se despliega y apuntaría a otro bloque.
  const openName = await page.locator('.section[data-collapsed="false"]').first().getAttribute('data-section');
  const collapsedName = await page.locator('.section[data-collapsed="true"]').first().getAttribute('data-section');
  const openSection = page.locator(`.section[data-section="${openName}"]`);
  const secondSection = page.locator(`.section[data-section="${collapsedName}"]`);
  console.log('bloque abierto:', openName, '· bloque a desplegar:', collapsedName);

  await secondSection.locator('.section__toggle').click();
  await page.waitForTimeout(150);
  check(await secondSection.getAttribute('data-collapsed') === 'false', 'el bloque no se desplegó al tocarlo');
  check(await secondSection.locator('.section__toggle').getAttribute('aria-expanded') === 'true',
    'aria-expanded no refleja el estado del bloque');

  await secondSection.locator('.section__toggle').click();
  await page.waitForTimeout(150);
  check(await secondSection.getAttribute('data-collapsed') === 'true', 'el bloque no se volvió a plegar');
  await secondSection.locator('.section__toggle').click();
  await page.waitForTimeout(150);

  // ── 4. Completar una tarea: UI optimista y progreso ────────────────────
  const firstTask = openSection.locator('.task').first();
  const before = await page.textContent('.ring__label');
  await firstTask.locator('.task__check').click();
  // La clase se aplica en el frame del gesto, antes de que resuelva IndexedDB.
  check((await firstTask.getAttribute('class')).includes('task--done'),
    'la tarea no se marcó de forma optimista');
  await page.waitForTimeout(200);
  const after = await page.textContent('.ring__label');
  console.log('progreso:', before, '→', after);
  check(before !== after, 'el anillo de progreso no cambió al completar');

  // ── 5. Swipe izquierdo: dispensar (en el otro bloque, para no deshacer
  //     la tarea recién completada) ─────────────────────────────────────
  const skipTarget = secondSection.locator('.task').first();
  const box = await skipTarget.boundingBox();
  if (check(box !== null, 'no se pudo medir la tarea para el gesto')) {
    await page.mouse.move(box.x + box.width - 30, box.y + box.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 10; step += 1) {
      await page.mouse.move(box.x + box.width - 30 - step * 20, box.y + box.height / 2);
    }
    await page.mouse.up();
    await page.waitForTimeout(280);
    check((await skipTarget.getAttribute('class')).includes('task--skipped'),
      'el swipe izquierdo no dispensó la tarea');
  }

  // ── 6. Hoja inferior: apertura, arrastre de cierre y foco ──────────────
  const sheet = page.locator('#sheet-editor');
  check(await sheet.isHidden(), 'la hoja del editor no arranca oculta');
  await page.click('.fab');
  await page.waitForSelector('#sheet-editor.is-open', { timeout: 3000 });
  await page.waitForTimeout(320); // deja asentar la animación de entrada
  check(await sheet.isVisible(), 'la hoja no se abrió al pulsar el FAB');
  check(await sheet.locator('.sheet__panel').getAttribute('aria-modal') === 'true',
    'la hoja no se anuncia como diálogo modal');

  // Cierre por arrastre hacia abajo desde la cabecera.
  const header = await sheet.locator('.sheet__header').boundingBox();
  await page.mouse.move(header.x + header.width / 2, header.y + header.height / 2);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(header.x + header.width / 2, header.y + header.height / 2 + step * 40);
  }
  await page.mouse.up();
  await page.waitForTimeout(400);
  check(await sheet.isHidden(), 'la hoja no se cerró al arrastrarla hacia abajo');

  // Cierre con Escape.
  await page.click('.fab');
  await page.waitForSelector('#sheet-editor.is-open');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check(await sheet.isHidden(), 'la hoja no se cerró con Escape');

  // ── 7. Alta de tarea desde la hoja, con bloque y días ──────────────────
  await page.click('.fab');
  await page.waitForSelector('#sheet-editor.is-open');
  await page.fill('#task-title', 'Tarea de prueba E2E');
  await page.selectOption('#task-block', 'anytime');
  await page.fill('#task-start', '12:00');
  await page.click('#sheet-editor button[type=submit]');
  await page.waitForTimeout(400);
  const created = await page.locator('.task').count();
  check(created === seeded + 1, `la tarea nueva no apareció en la lista (${created} vs ${seeded + 1})`);
  check(await sheet.isHidden(), 'la hoja no se cerró tras guardar');

  // Una tarea limitada a otro día de la semana no debe renderizarse.
  const otroDia = (hoy.getDay() + 3) % 7;
  await page.click('.fab');
  await page.waitForSelector('#sheet-editor.is-open');
  await page.fill('#task-title', 'Sólo otro día de la semana');
  await page.selectOption('#task-block', 'anytime');
  await page.click(`label[for="day-${otroDia}"]`);
  await page.click('#sheet-editor button[type=submit]');
  await page.waitForTimeout(400);
  check(await page.locator('.task').count() === created,
    'una tarea de otro día se está renderizando hoy');
  check(await page.locator('.task__title', { hasText: 'Sólo otro día' }).count() === 0,
    'la tarea de otro día aparece en el DOM');

  // El selector de días no deja marcar un día en que el bloque no existe.
  await page.click('.fab');
  await page.waitForSelector('#sheet-editor.is-open');
  await page.selectOption('#task-block', 'class_tuesday');
  await page.waitForTimeout(120);
  const habilitados = await page.locator('.daypicker__input:not([disabled])').evaluateAll(
    (nodes) => nodes.map((node) => Number(node.value)),
  );
  console.log('días permitidos para «Clase» del martes:', habilitados);
  check(habilitados.length === 1 && habilitados[0] === 2,
    `el bloque de martes debería permitir sólo el día 2, permite ${habilitados.join(', ')}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // ── 8. Hojas de histórico y ajustes ────────────────────────────────────
  await page.click('.bar__btn >> nth=0');
  await page.waitForSelector('#sheet-history.is-open');
  const heatmap = await page.evaluate(() => {
    const canvas = document.querySelector('.heatmap__canvas');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted += 1;
    return { width: canvas.width, height: canvas.height, painted };
  });
  console.log('heatmap:', heatmap);
  check(heatmap.painted > 0, 'el heatmap no dibujó ningún píxel dentro de la hoja');
  await page.click('#sheet-history .sheet__close');
  await page.waitForTimeout(400);

  await page.click('.bar__btn >> nth=1');
  await page.waitForSelector('#sheet-settings.is-open');
  check(await page.locator('#sheet-settings .settings').isVisible(), 'los ajustes no se muestran en su hoja');
  await page.click('#sheet-settings .sheet__close');
  await page.waitForTimeout(400);

  // ── 9. Persistencia tras recargar ──────────────────────────────────────
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.section');
  check(await page.locator('.task').count() === created, 'las tareas no persistieron tras recargar');
  check(await page.locator('.section[data-active="true"]').count() <= 1,
    'tras recargar hay más de un bloque en curso');
  check(await page.locator('.task--done').count() >= 1, 'el estado completado no persistió');

  // ── 10. Service Worker: alcance relativo al subdirectorio ──────────────
  const sw = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { supported: false };
    const registration = await navigator.serviceWorker.ready;
    const [name] = await caches.keys();
    const keys = await (await caches.open(name)).keys();
    return {
      supported: true,
      scope: registration.scope,
      script: registration.active?.scriptURL,
      cache: name,
      cached: keys.length,
      sample: keys.slice(0, 2).map((request) => request.url),
      controlled: Boolean(navigator.serviceWorker.controller),
    };
  });
  console.log('service worker:', sw);
  check(sw.supported, 'el navegador no soporta Service Worker');
  check(sw.scope?.endsWith(BASE_PATH), `el alcance debería ser ${BASE_PATH}, es ${sw.scope}`);
  check(sw.script?.endsWith(`${BASE_PATH}sw.js`), `script inesperado: ${sw.script}`);
  check(sw.cached >= 30, `precaché incompleto: ${sw.cached} recursos`);
  check((sw.sample ?? []).every((url) => url.includes(BASE_PATH)),
    `el precaché no está bajo el subdirectorio: ${(sw.sample ?? []).join(', ')}`);

  // ── 11. Manifest: rutas resueltas bajo el subdirectorio ────────────────
  const manifest = await page.evaluate(async () => {
    const href = document.querySelector('link[rel=manifest]').href;
    const raw = await (await fetch(href)).json();
    return {
      href,
      start: new URL(raw.start_url, href).pathname,
      scope: new URL(raw.scope, href).pathname,
      icon: new URL(raw.icons[0].src, href).pathname,
    };
  });
  console.log('manifest:', manifest);
  check(manifest.start === `${BASE_PATH}index.html`, `start_url resuelve a ${manifest.start}`);
  check(manifest.scope === BASE_PATH, `scope resuelve a ${manifest.scope}`);
  check(manifest.icon === `${BASE_PATH}public/icons/icon-192.png`, `icono resuelve a ${manifest.icon}`);

  // ── 12. Arranque sin conexión ──────────────────────────────────────────
  await context.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.section', { timeout: 10_000 });
  check(await page.locator('.task').count() === created, 'la aplicación no arranca sin conexión');
  await context.setOffline(false);

  // ── 13. Volcado de copia de seguridad ──────────────────────────────────
  const dump = await page.evaluate(async () => {
    const backup = await globalThis.__routineTracker.repository.exportBackup();
    return { schema: backup.schema, tasks: backup.data.tasks.length, logs: backup.data.daily_logs.length };
  });
  console.log('backup:', dump);
  check(dump.schema === 4, 'el volcado no declara el esquema 4');
  check(dump.tasks === INITIAL_TASKS.length + 2,
    `el volcado debería tener ${INITIAL_TASKS.length + 2} tareas, tiene ${dump.tasks}`);

  if (process.env.SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/e2e-claro.png`, fullPage: true });
  }
} finally {
  await browser.close();
  server.close();
}

if (errors.length > 0) {
  console.error('\nFALLOS:');
  for (const error of errors) console.error(' ·', error);
  process.exit(1);
}
console.log('\nSmoke test OK');
