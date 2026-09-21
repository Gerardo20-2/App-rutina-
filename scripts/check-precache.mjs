/**
 * Verifica la lista de precaché del Service Worker.
 *
 * Un `PRECACHE_URLS` desincronizado es un fallo silencioso: la app sigue
 * funcionando online y sólo rompe sin conexión, que es justo el caso que
 * nadie prueba a mano. Esta comprobación corre en CI.
 *
 *   1. Toda URL listada debe existir en el repositorio.
 *   2. Todo módulo de `src/` y toda hoja de estilos debe estar listada.
 *
 *     node scripts/check-precache.mjs
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SW_PATH = resolve(ROOT, 'public/sw.js');

const source = readFileSync(SW_PATH, 'utf8');
const match = source.match(/const PRECACHE_URLS = \[([\s\S]*?)\];/);
if (!match) {
  console.error('No se encontró PRECACHE_URLS en public/sw.js');
  process.exit(1);
}

const listed = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
const errors = [];

// 1. Cada URL listada existe (salvo './', que es la propia navegación).
for (const url of listed) {
  if (url === './') continue;
  const filePath = resolve(ROOT, url.replace(/^\.\//, ''));
  if (!existsSync(filePath)) errors.push(`listado pero inexistente: ${url}`);
}

// 2. Cada módulo y hoja de estilos del código fuente está listado.
const listedSet = new Set(listed);
for (const file of walk(resolve(ROOT, 'src'))) {
  if (!/\.(js|css)$/.test(file)) continue;
  const url = `./${relative(ROOT, file).split('\\').join('/')}`;
  if (!listedSet.has(url)) errors.push(`falta en el precaché: ${url}`);
}

if (errors.length > 0) {
  console.error('Precaché del Service Worker desincronizado:');
  for (const error of errors) console.error(`  · ${error}`);
  process.exit(1);
}

console.log(`Precaché OK — ${listed.length} recursos verificados.`);

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
