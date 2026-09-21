/**
 * Prueba de humo end-to-end sobre Chromium.
 *
 * Cubre lo que las pruebas de dominio no pueden: render real, gestos,
 * IndexedDB del navegador, canvas del heatmap, Service Worker y arranque sin
 * conexión.
 *
 * Playwright NO es una dependencia del proyecto: esta prueba es opcional y no
 * corre en CI. Para ejecutarla hace falta tenerlo disponible:
 *
 *     npm install --no-save playwright && npx playwright install chromium
 *     node tests/e2e/smoke.mjs
 *
 * El servidor estático se levanta aquí mismo con `node:http`, así que no hay
 * nada más que preparar.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import('playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT ?? 8123);

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
  const relative = normalize(requested === '/' ? '/index.html' : requested).replace(/^(\.\.[/\\])+/, '');
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
const BASE = `http://127.0.0.1:${PORT}`;
console.log(`Sirviendo ${ROOT} en ${BASE}`);

/** @type {string[]} */
const errors = [];
const check = (condition, message) => { if (!condition) errors.push(message); };

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

  // 1. Arranque: motor de persistencia y siembra inicial.
  const engine = await page.textContent('.settings__engine');
  console.log('motor de persistencia:', engine);
  check(engine === 'IndexedDB', `se esperaba IndexedDB, hay "${engine}"`);

  const seeded = await page.locator('.task').count();
  console.log('tareas sembradas:', seeded);
  check(seeded > 0, 'no se sembró ninguna tarea');
  check(!(await page.locator('.empty').isVisible()), 'el estado vacío se muestra con tareas presentes');

  // 2. Completar una tarea actualiza el anillo de progreso.
  const before = await page.textContent('.ring__label');
  await page.locator('.task').first().locator('.task__check').click();
  await page.waitForTimeout(150);
  const after = await page.textContent('.ring__label');
  console.log('progreso:', before, '→', after);
  check(before !== after, 'el anillo de progreso no cambió al completar');
  check((await page.locator('.task').first().getAttribute('class')).includes('task--done'),
    'la tarea no quedó marcada como completada');

  // 3. Swipe izquierdo dispensa la tarea.
  const second = page.locator('.task').nth(1);
  const box = await second.boundingBox();
  await page.mouse.move(box.x + box.width - 30, box.y + box.height / 2);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(box.x + box.width - 30 - step * 20, box.y + box.height / 2);
  }
  await page.mouse.up();
  await page.waitForTimeout(250);
  check((await second.getAttribute('class')).includes('task--skipped'),
    'el swipe izquierdo no dispensó la tarea');

  // 4. Alta de tarea desde el botón flotante.
  await page.click('.fab');
  await page.waitForSelector('.dialog[open]');
  await page.fill('#task-title', 'Tarea de prueba E2E');
  await page.selectOption('#task-section', 'afternoon');
  await page.fill('#task-minutes', '12');
  await page.click('.dialog__form button[type=submit]');
  await page.waitForTimeout(300);
  const created = await page.locator('.task').count();
  check(created === seeded + 1, 'la tarea nueva no apareció en la lista');

  // 5. El heatmap pinta píxeles reales.
  const heatmap = await page.evaluate(() => {
    const canvas = document.querySelector('.heatmap__canvas');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted += 1;
    return { width: canvas.width, height: canvas.height, painted };
  });
  console.log('heatmap:', heatmap);
  check(heatmap.painted > 0, 'el heatmap no dibujó ningún píxel');

  // 6. Persistencia tras recargar.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.task');
  check(await page.locator('.task').count() === created, 'las tareas no persistieron tras recargar');
  check(await page.locator('.task--done').count() === 1, 'el estado completado no persistió');

  // 7. Service Worker: alcance raíz y precaché completo.
  const sw = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { supported: false };
    const registration = await navigator.serviceWorker.ready;
    const [name] = await caches.keys();
    const keys = await (await caches.open(name)).keys();
    return {
      supported: true,
      scope: registration.scope,
      cache: name,
      cached: keys.length,
      controlled: Boolean(navigator.serviceWorker.controller),
    };
  });
  console.log('service worker:', sw);
  check(sw.supported, 'el navegador no soporta Service Worker');
  check(sw.scope?.endsWith('/'), `alcance inesperado: ${sw.scope}`);
  check(sw.cached >= 30, `precaché incompleto: ${sw.cached} recursos`);

  // 8. Arranque sin conexión.
  await context.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.task', { timeout: 10_000 });
  check(await page.locator('.task').count() === created, 'la aplicación no arranca sin conexión');
  await context.setOffline(false);

  // 9. Volcado de copia de seguridad.
  const dump = await page.evaluate(async () => {
    const backup = await globalThis.__routineTracker.repository.exportBackup();
    return { schema: backup.schema, tasks: backup.data.tasks.length, logs: backup.data.daily_logs.length };
  });
  console.log('backup:', dump);
  check(dump.schema === 2, 'el volcado no declara el esquema 2');
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
