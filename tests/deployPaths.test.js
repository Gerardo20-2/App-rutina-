import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * GitHub Pages sirve el proyecto en `https://usuario.github.io/<repo>/`. Toda
 * ruta absoluta (`/src/...`, `/sw.js`) apunta entonces a la raíz del dominio y
 * da 404. Estas pruebas fijan esa restricción en CI, donde no hay navegador:
 * el fallo sólo se manifestaría al desplegar.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');

/** Despliegue simulado bajo subdirectorio. */
const ORIGIN = 'https://usuario.github.io';
const BASE = `${ORIGIN}/App-rutina-/`;

test('index.html no referencia ningún recurso con ruta absoluta', () => {
  const html = read('index.html');
  const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(refs.length > 5, 'se esperaban varias referencias a recursos');

  const absolute = refs.filter((ref) => ref.startsWith('/'));
  assert.deepEqual(absolute, [], `rutas absolutas en index.html: ${absolute.join(', ')}`);

  // Los anclas internas (#contenido) y las rutas relativas son las únicas admitidas.
  const invalid = refs.filter((ref) => !ref.startsWith('./') && !ref.startsWith('#'));
  assert.deepEqual(invalid, [], `referencias no relativas: ${invalid.join(', ')}`);
});

test('el manifest resuelve a la raíz de la aplicación bajo un subdirectorio', () => {
  const manifestUrl = `${BASE}public/manifest.webmanifest`;
  const manifest = JSON.parse(read('public/manifest.webmanifest'));

  assert.equal(new URL(manifest.start_url, manifestUrl).href, `${BASE}index.html`);
  assert.equal(new URL(manifest.scope, manifestUrl).href, BASE);
  assert.equal(new URL(manifest.icons[0].src, manifestUrl).href, `${BASE}public/icons/icon-192.png`);
  assert.equal(new URL(manifest.shortcuts[0].url, manifestUrl).href, `${BASE}?action=new-task`);

  // El start_url debe caer dentro del scope, o el navegador ignora el manifest.
  assert.ok(new URL(manifest.start_url, manifestUrl).href.startsWith(new URL(manifest.scope, manifestUrl).href));
});

test('ningún campo del manifest es una ruta absoluta', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest'));
  const paths = [
    manifest.start_url,
    manifest.scope,
    ...manifest.icons.map((icon) => icon.src),
    ...manifest.shortcuts.flatMap((shortcut) => [shortcut.url, ...(shortcut.icons ?? []).map((i) => i.src)]),
  ];
  const absolute = paths.filter((path) => path.startsWith('/'));
  assert.deepEqual(absolute, [], `rutas absolutas en el manifest: ${absolute.join(', ')}`);
});

test('el registro del Service Worker usa ruta y alcance relativos', () => {
  const main = read('src/main.js');
  assert.match(main, /const swPath = '\.\/sw\.js'/, 'la ruta del worker debe ser relativa');
  assert.match(main, /register\(swPath, \{ scope: '\.\/' \}\)/, 'el alcance debe declararse como ./');
  assert.doesNotMatch(main, /register\(\s*'\//, 'no puede registrarse con una ruta absoluta');
});

test('el sw.js de la raíz importa la implementación con ruta relativa', () => {
  const shim = read('sw.js');
  assert.match(shim, /importScripts\('\.\/public\/sw\.js'\)/);
  assert.doesNotMatch(shim, /importScripts\('\//);
});

test('el precaché se resuelve contra el scope, no contra la raíz del dominio', () => {
  const sw = read('public/sw.js');
  assert.match(sw, /self\.registration\?\.scope/, 'APP_SCOPE debe derivarse del scope del registro');

  const listed = [...sw.match(/const ASSETS_TO_CACHE = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)]
    .map((match) => match[1]);
  assert.ok(listed.length > 30, `el precaché parece incompleto: ${listed.length} recursos`);

  const absolute = listed.filter((url) => url.startsWith('/') || /^https?:/.test(url));
  assert.deepEqual(absolute, [], `rutas absolutas en el precaché: ${absolute.join(', ')}`);

  // Resueltas contra el scope, todas caen dentro del subdirectorio desplegado.
  for (const url of listed) {
    assert.ok(new URL(url, BASE).href.startsWith(BASE), `${url} se sale del subdirectorio`);
  }
});

test('ningún módulo importa por ruta absoluta', () => {
  const files = [
    'src/main.js', 'src/ui/renderer.js', 'src/domain/routineService.js',
    'src/storage/repository.js', 'src/ui/components/bottomSheet.js',
    'src/ui/components/taskItem.js', 'src/ui/components/touchTaskItem.js',
  ];
  for (const file of files) {
    const source = read(file);
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    const absolute = imports.filter((specifier) => specifier.startsWith('/'));
    assert.deepEqual(absolute, [], `${file} importa por ruta absoluta: ${absolute.join(', ')}`);
  }
});

test('las hojas de estilo no referencian recursos absolutos', () => {
  for (const file of ['base.css', 'layout.css', 'components.css']) {
    const css = read(`src/ui/styles/${file}`);
    const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((match) => match[1].replace(/['"]/g, ''));
    const absolute = urls.filter((url) => url.startsWith('/'));
    assert.deepEqual(absolute, [], `${file} referencia ${absolute.join(', ')}`);
  }
});
