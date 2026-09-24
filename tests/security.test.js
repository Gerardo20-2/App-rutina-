import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  encryptJson, decryptJson, sha256Hex, isEncryptedEnvelope, CryptoError, CRYPTO_CONFIG,
  fromBase64,
} from '../src/security/cryptoService.js';
import { safeJsonParse, sanitizeDeep, deepFreeze } from '../src/security/objectGuard.js';
import { createTask, sanitizeText, ValidationError } from '../src/domain/taskValidator.js';
import { Repository } from '../src/storage/repository.js';
import { LocalStorageService, MemoryBackend } from '../src/storage/localStorageService.js';
import { StorageError } from '../src/storage/storageAdapter.js';
import { BLOCK_CATALOG } from '../src/domain/timeBlockService.js';
import { DEFAULT_PREFERENCES, HAPTIC_PATTERNS, LIMITS, EVENTS } from '../src/core/constants.js';
import { INITIAL_TASKS } from '../src/storage/seedData.js';
import { EventBus } from '../src/core/events.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PASSPHRASE = 'correcto caballo batería grapa';

const XSS_PAYLOADS = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  '<svg/onload=alert(1)>',
  "javascript:alert('x')",
  '</span><iframe srcdoc="<script>parent.alert(1)</script>">',
];

/* ------------------------------------------------------------------ *
 * DOM mínimo: suficiente para montar componentes reales sin jsdom. Los
 * sumideros HTML lanzan: si algún componente los usa, la prueba lo delata.
 * ------------------------------------------------------------------ */

class FakeNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.childNodes = [];
    this.parentNode = null;
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  appendChild(child) {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child) {
    this.childNodes = this.childNodes.filter((node) => node !== child);
    child.parentNode = null;
    return child;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  get textContent() {
    return this.nodeType === 3 ? this.data : this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value) {
    if (this.nodeType === 3) {
      this.data = String(value);
      return;
    }
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes = [];
    if (value !== '') this.appendChild(new FakeText(String(value)));
  }
}

class FakeText extends FakeNode {
  constructor(data) {
    super(3);
    this.data = data;
  }
}

const HTML_SINK = () => {
  throw new Error('Sumidero HTML prohibido: se intentó interpretar texto como marcado');
};

class FakeElement extends FakeNode {
  constructor(tagName) {
    super(1);
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.dataset = {};
    this.style = { setProperty() {} };
    this.className = '';
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, force) => {
        const on = force ?? !classes.has(name);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      contains: (name) => classes.has(name),
    };
    this.listeners = new Map();
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }

  set innerHTML(_) { HTML_SINK(); }

  get innerHTML() { return HTML_SINK(); }

  set outerHTML(_) { HTML_SINK(); }

  insertAdjacentHTML() { HTML_SINK(); }
}

function installFakeDom() {
  globalThis.document = {
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_, tag) => new FakeElement(tag),
    createTextNode: (data) => new FakeText(data),
    write: HTML_SINK,
    writeln: HTML_SINK,
  };
  globalThis.requestAnimationFrame ??= (fn) => setTimeout(fn, 0);
}

/** Todos los elementos del subárbol, incluida la raíz. */
function* walkElements(node) {
  if (node.nodeType === 1) yield node;
  for (const child of node.childNodes) yield* walkElements(child);
}

/* ------------------------------------------------------------------ *
 * 1. Inyección de marcado (XSS)
 * ------------------------------------------------------------------ */

installFakeDom();
const { createTaskItem } = await import('../src/ui/components/taskItem.js');
const { createToaster } = await import('../src/ui/components/toast.js');
const { h } = await import('../src/ui/dom.js');

for (const payload of XSS_PAYLOADS) {
  test(`XSS: el título ${JSON.stringify(payload)} se pinta como texto inerte`, () => {
    const task = createTask({ title: payload, sectionId: 'dawn' });
    assert.equal(task.title, payload, 'el validador no altera el texto visible: no lo interpreta');

    const item = createTaskItem({
      task,
      record: { completed: false, completedAt: null, skipped: false },
      onToggle() {}, onSkip() {}, onEdit() {},
    });

    const tags = [...walkElements(item.el)].map((el) => el.tagName);
    for (const forbidden of ['SCRIPT', 'IMG', 'SVG', 'IFRAME']) {
      assert.ok(!tags.includes(forbidden), `se creó un <${forbidden.toLowerCase()}> a partir del título`);
    }

    const titleEl = [...walkElements(item.el)].find((el) => el.className === 'task__title');
    assert.equal(titleEl.childNodes.length, 1);
    assert.equal(titleEl.firstChild.nodeType, 3, 'el título es un nodo de texto');
    assert.equal(titleEl.textContent, payload);

    // Los atributos también reciben el título: se asignan con setAttribute,
    // que no parsea HTML ni ejecuta manejadores.
    for (const el of walkElements(item.el)) {
      for (const name of el.attributes.keys()) {
        assert.ok(!/^on/i.test(name), `atributo manejador inyectado: ${name}`);
      }
    }

    // Una actualización con otro payload sigue el mismo camino.
    item.update({ task: { ...task, title: `${payload}!` }, record: { completed: true, completedAt: null, skipped: false } });
    assert.equal(titleEl.textContent, `${payload}!`);
    item.destroy();
  });
}

test('XSS: los avisos (toast) muestran el mensaje como texto', () => {
  const bus = new EventBus();
  const toaster = createToaster(bus);
  bus.emit(EVENTS.TOAST, { message: XSS_PAYLOADS[1], timeout: 1 });
  const tags = [...walkElements(toaster.el)].map((el) => el.tagName);
  assert.ok(!tags.includes('IMG'));
  assert.equal(toaster.el.textContent, XSS_PAYLOADS[1]);
  toaster.destroy();
});

test('XSS: h() trata los hijos string como texto y nunca como marcado', () => {
  const el = h('p', { text: XSS_PAYLOADS[0] }, [XSS_PAYLOADS[1]]);
  assert.deepEqual([...walkElements(el)].map((node) => node.tagName), ['P']);
});

test('auditoría estática: ningún módulo usa sumideros HTML ni evaluación dinámica', () => {
  const SINKS = /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function\s*\(|setTimeout\(\s*['"`]/;
  const offenders = [];
  const files = [...walk(join(ROOT, 'src')), join(ROOT, 'public/sw.js'), join(ROOT, 'sw.js')]
    .filter((file) => file.endsWith('.js'));
  for (const file of files) {
    const code = stripComments(readFileSync(file, 'utf8'));
    if (SINKS.test(code)) offenders.push(relative(ROOT, file));
  }
  assert.deepEqual(offenders, []);
});

test('auditoría estática: todo enlace o ventana hacia fuera lleva rel="noopener noreferrer"', () => {
  for (const file of walk(join(ROOT, 'src')).filter((f) => f.endsWith('.js'))) {
    const code = stripComments(readFileSync(file, 'utf8'));
    assert.ok(!/window\.open\s*\(/.test(code), `${relative(ROOT, file)} abre ventanas`);
    for (const match of code.matchAll(/h\('a',\s*\{([^}]*)\}/g)) {
      assert.match(match[1], /rel:\s*'noopener noreferrer'/, `${relative(ROOT, file)}: <a> sin rel`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * 2. Sanitización de entradas
 * ------------------------------------------------------------------ */

test('sanitizeText elimina controles, secuencias ANSI y trucos bidireccionales', () => {
  assert.equal(sanitizeText('Agua\u0000\u0007 fría'), 'Agua fría');
  assert.equal(sanitizeText('\u001b[31mRojo\u001b[0m'), '[31mRojo[0m', 'ESC eliminado: la secuencia queda inerte');
  assert.equal(sanitizeText('Leer‮txt.exe'), 'Leertxt.exe', 'override RTL eliminado');
  assert.equal(sanitizeText('a​b﻿c⁦d⁩'), 'abcd');
  assert.equal(sanitizeText('uno\n\tdos\r\ntres'), 'uno dos tres');
  assert.equal(sanitizeText('\u0085\u009Fx'), 'x', 'controles C1');
  assert.equal(sanitizeText('é'), 'é', 'normalización NFC');
  assert.equal(sanitizeText('\uD800roto'), '�roto', 'surrogate suelto');
  assert.equal(sanitizeText('👩‍💻 código'), '👩‍💻 código', 'ZWJ de emojis intacto');
  assert.equal(sanitizeText(42), '');
});

test('validateTask aplica la sanitización y el límite de longitud al título', () => {
  assert.equal(createTask({ title: '‮  Meditar\u0000 ', sectionId: 'dawn' }).title, 'Meditar');
  assert.ok(LIMITS.TASK_TITLE_MAX <= 100);
  assert.throws(
    () => createTask({ title: 'x'.repeat(LIMITS.TASK_TITLE_MAX + 1), sectionId: 'dawn' }),
    ValidationError,
  );
  assert.throws(() => createTask({ title: '​\u0000‮', sectionId: 'dawn' }), ValidationError,
    'un título sólo de invisibles equivale a vacío');
});

/* ------------------------------------------------------------------ *
 * 3. Prototype pollution y catálogos congelados
 * ------------------------------------------------------------------ */

test('safeJsonParse descarta __proto__, constructor y prototype en cualquier nivel', () => {
  const parsed = safeJsonParse('{"a":1,"__proto__":{"polluted":true},"b":{"constructor":{"prototype":{"x":1}},"c":[{"__proto__":{"y":1}}]}}');
  assert.deepEqual(parsed, { a: 1, b: { c: [{}] } });
  const merged = Object.assign({}, parsed);
  assert.equal(merged.polluted, undefined);
  assert.equal({}.polluted, undefined);
});

test('sanitizeDeep limpia objetos ya construidos y corta ciclos', () => {
  const hostile = JSON.parse('{"ok":1,"__proto__":{"polluted":true}}');
  hostile.self = hostile;
  hostile.fn = () => 1;
  assert.deepEqual(sanitizeDeep(hostile), { ok: 1 });
});

test('catálogos globales congelados en profundidad', () => {
  assert.ok(Object.isFrozen(BLOCK_CATALOG.dawn));
  assert.ok(Object.isFrozen(BLOCK_CATALOG.dawn.rules[0]));
  assert.ok(Object.isFrozen(DEFAULT_PREFERENCES));
  assert.ok(Object.isFrozen(INITIAL_TASKS[0]));
  const nested = Object.values(HAPTIC_PATTERNS).find((value) => typeof value === 'object');
  if (nested) assert.ok(Object.isFrozen(nested));
  // Los módulos ES corren en modo estricto: mutar un congelado lanza.
  assert.throws(() => { BLOCK_CATALOG.dawn.rules[0].start = '00:00'; }, TypeError);
  assert.throws(() => { DEFAULT_PREFERENCES.theme = 'dark'; }, TypeError);
  const frozen = deepFreeze({ a: { b: [1, { c: 2 }] } });
  assert.throws(() => { frozen.a.b[1].c = 3; }, TypeError);
});

/* ------------------------------------------------------------------ *
 * 4. Criptografía
 * ------------------------------------------------------------------ */

const STATE = { tasks: [{ id: 'task-wake-up', title: 'Despertar' }], streak: 12, nota: 'ñ 🌅' };

test('cifrado: ida y vuelta con la clave correcta', async () => {
  const envelope = await encryptJson(STATE, PASSPHRASE);
  assert.ok(isEncryptedEnvelope(envelope));
  for (const field of ['salt', 'iv', 'ciphertext', 'version', 'checksum']) {
    assert.ok(field in envelope, `falta ${field}`);
  }
  assert.equal(envelope.iterations, CRYPTO_CONFIG.ITERATIONS);
  assert.equal(fromBase64(envelope.salt).length, 16);
  assert.equal(fromBase64(envelope.iv).length, 12);
  assert.match(envelope.checksum, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(envelope).includes('Despertar'), 'nada del texto en claro en el sobre');
  assert.deepEqual(await decryptJson(envelope, PASSPHRASE), STATE);
  assert.deepEqual(await decryptJson(JSON.stringify(envelope), PASSPHRASE), STATE, 'también desde texto');
});

test('cifrado: salt e IV únicos por operación', async () => {
  const [a, b] = await Promise.all([encryptJson(STATE, PASSPHRASE), encryptJson(STATE, PASSPHRASE)]);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
});

test('cifrado: frase de paso débil rechazada', async () => {
  await assert.rejects(encryptJson(STATE, '1234'), (error) => error instanceof CryptoError && error.code === 'WEAK_PASSPHRASE');
  await assert.rejects(encryptJson(STATE, undefined), { code: 'WEAK_PASSPHRASE' });
});

test('descifrado: clave incorrecta falla con excepción controlada', async () => {
  const envelope = await encryptJson(STATE, PASSPHRASE);
  await assert.rejects(
    decryptJson(envelope, 'otra frase cualquiera'),
    (error) => error instanceof CryptoError && error.code === 'DECRYPT_FAILED',
  );
  await assert.rejects(decryptJson(envelope, ''), { code: 'WEAK_PASSPHRASE' });
});

test('descifrado: payload adulterado detectado por el checksum antes del KDF', async () => {
  const envelope = await encryptJson(STATE, PASSPHRASE);
  const tampered = { ...envelope, ciphertext: flipFirstByte(envelope.ciphertext) };
  await assert.rejects(decryptJson(tampered, PASSPHRASE), { name: 'CryptoError', code: 'CHECKSUM_MISMATCH' });
});

test('descifrado: adulterar y recalcular el checksum no basta (etiqueta AES-GCM)', async () => {
  const envelope = await encryptJson(STATE, PASSPHRASE);
  const tampered = await reseal({ ...envelope, ciphertext: flipFirstByte(envelope.ciphertext) });
  await assert.rejects(decryptJson(tampered, PASSPHRASE), { code: 'DECRYPT_FAILED' });
});

test('descifrado: la cabecera está autenticada (AAD)', async () => {
  const envelope = await encryptJson(STATE, PASSPHRASE);
  const otherIv = await encryptJson(STATE, PASSPHRASE);
  const tampered = await reseal({ ...envelope, iv: otherIv.iv });
  await assert.rejects(decryptJson(tampered, PASSPHRASE), { code: 'DECRYPT_FAILED' });
});

test('descifrado: sobres malformados rechazados sin tocar la criptografía', async () => {
  const envelope = await encryptJson(STATE, PASSPHRASE);
  const cases = [
    '{no es json',
    { ...envelope, format: 'otro' },
    { ...envelope, version: 99 },
    { ...envelope, cipher: 'AES-CBC' },
    { ...envelope, iterations: 1_000 },
    { ...envelope, iterations: 1e12 },
    { ...envelope, salt: 'AAAA' },
    { ...envelope, iv: '***' },
    { ...envelope, ciphertext: undefined },
  ];
  for (const input of cases) {
    await assert.rejects(decryptJson(input, PASSPHRASE), { code: 'BAD_ENVELOPE' }, JSON.stringify(input).slice(0, 60));
  }
});

/* ------------------------------------------------------------------ *
 * 5. Importación de copias
 * ------------------------------------------------------------------ */

async function makeRepository() {
  const repository = new Repository({ adapter: new LocalStorageService({ backend: new MemoryBackend() }) });
  await repository.open();
  return repository;
}

test('import: copia cifrada restaurada con la frase correcta', async () => {
  const source = await makeRepository();
  await source.saveTask({ title: 'Agua', sectionId: 'dawn' });
  const envelope = await source.exportEncryptedBackup(PASSPHRASE);
  assert.ok(!JSON.stringify(envelope).includes('Agua'));

  const target = await makeRepository();
  const result = await target.importBackup(JSON.stringify(envelope), { passphrase: PASSPHRASE });
  assert.equal(result.encrypted, true);
  assert.ok((await target.listTasks()).some((task) => task.title === 'Agua'));
});

test('import: copia cifrada sin frase, con frase errónea o adulterada no toca los datos', async () => {
  const source = await makeRepository();
  await source.saveTask({ title: 'Secreto', sectionId: 'dawn' });
  const envelope = await source.exportEncryptedBackup(PASSPHRASE);

  const target = await makeRepository();
  const before = await target.listTasks();
  await assert.rejects(target.importBackup(envelope), (error) => error instanceof StorageError && error.code === 'PASSPHRASE_REQUIRED');
  await assert.rejects(target.importBackup(envelope, { passphrase: 'no es la frase' }), { code: 'DECRYPT_FAILED' });
  const tampered = { ...envelope, ciphertext: flipFirstByte(envelope.ciphertext) };
  await assert.rejects(target.importBackup(tampered, { passphrase: PASSPHRASE }), { code: 'CHECKSUM_MISMATCH' });
  assert.deepEqual(await target.listTasks(), before);
});

test('import: JSON contaminado con __proto__ no contamina prototipos', async () => {
  const repository = await makeRepository();
  const hostile = `{
    "__proto__": {"polluted": "raíz"},
    "constructor": {"prototype": {"polluted": "ctor"}},
    "data": {
      "__proto__": {"polluted": "data"},
      "tasks": [{
        "__proto__": {"isAdmin": true, "polluted": "fila"},
        "id": "task-hostile", "title": "<img src=x onerror=alert(1)>", "sectionId": "dawn",
        "createdAt": "2026-09-01T00:00:00.000Z"
      }],
      "system_metadata": [
        {"key": "user_preferences", "value": {"__proto__": {"polluted": "meta"}, "theme": "dark"}},
        {"key": "clave_ajena", "value": {"x": 1}}
      ]
    }
  }`;
  const result = await repository.importBackup(hostile);
  assert.equal(result.tasks, 1);
  assert.equal(result.encrypted, false);
  assert.equal({}.polluted, undefined, 'Object.prototype intacto');
  assert.equal(Object.prototype.isAdmin, undefined);

  const [task] = await repository.listTasks();
  assert.equal(task.title, '<img src=x onerror=alert(1)>', 'se guarda como texto, se pintará como texto');
  assert.equal(task.isAdmin, undefined);
  assert.ok(!Object.hasOwn(task, '__proto__'));
  assert.equal((await repository.getPreferences()).theme, 'dark');
  assert.equal(await repository.getMeta('clave_ajena'), undefined, 'metadatos desconocidos descartados');
});

test('import: objetos ya construidos con __proto__ propio también se sanean', async () => {
  const repository = await makeRepository();
  const dump = JSON.parse('{"data":{"tasks":[{"__proto__":{"polluted":1},"id":"task-obj","title":"Ok","sectionId":"dawn","createdAt":"2026-09-01T00:00:00.000Z"}]}}');
  await repository.importBackup(dump);
  assert.equal({}.polluted, undefined);
});

test('import: payloads malformados fallan de forma controlada', async () => {
  const repository = await makeRepository();
  await assert.rejects(repository.importBackup('{roto'), (error) => error instanceof StorageError && error.code === 'BAD_DUMP');
  await assert.rejects(repository.importBackup('null'), { code: 'BAD_DUMP' });
  await assert.rejects(repository.importBackup('{"data":[1,2]}'), { code: 'BAD_DUMP' });
  const result = await repository.importBackup('{"data":{"tasks":"no-array","daily_logs":{}}}');
  assert.deepEqual({ tasks: result.tasks, logs: result.logs }, { tasks: 0, logs: 0 });
});

/* ------------------------------------------------------------------ *
 * 6. CSP y Service Worker
 * ------------------------------------------------------------------ */

test('index.html declara una CSP estricta antes de cualquier recurso', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(meta, 'falta la meta CSP');
  const policy = Object.fromEntries(meta[1].split(';').map((part) => part.trim()).filter(Boolean)
    .map((part) => {
      const [name, ...values] = part.split(/\s+/);
      return [name, values];
    }));
  assert.deepEqual(policy['default-src'], ["'none'"]);
  assert.deepEqual(policy['script-src'], ["'self'"], 'sin unsafe-inline ni unsafe-eval en scripts');
  assert.deepEqual(policy['connect-src'], ["'self'"]);
  assert.deepEqual(policy['base-uri'], ["'none'"]);
  assert.deepEqual(policy['form-action'], ["'none'"]);
  assert.deepEqual(policy['object-src'], ["'none'"]);

  const cspIndex = html.indexOf('Content-Security-Policy');
  for (const tag of ['<link', '<script']) {
    assert.ok(html.indexOf(tag) > cspIndex, `${tag} aparece antes de la CSP`);
  }
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'script inline incompatible con la CSP');
  assert.ok(!/\son[a-z]+=/i.test(html), 'manejador inline incompatible con la CSP');
});

test('Service Worker: rechaza subrecursos de otro origen y sólo cachea respuestas propias', async () => {
  const sw = loadServiceWorker();

  const crossOrigin = sw.dispatchFetch({ url: 'https://evil.example/steal.js', mode: 'no-cors' });
  assert.equal((await crossOrigin).type, 'error', 'petición cruzada rechazada con error de red');

  sw.network = () => fakeResponse({ url: 'https://evil.example/app.js', redirected: true });
  await sw.dispatchFetch({ url: `${sw.scope}src/main.js` });
  await flush();
  assert.equal(sw.puts.length, 0, 'una redirección no se cachea');

  sw.network = () => fakeResponse({ url: `${sw.scope}src/main.js`, type: 'opaque' });
  await sw.dispatchFetch({ url: `${sw.scope}src/main.js` });
  await flush();
  assert.equal(sw.puts.length, 0, 'una respuesta opaca no se cachea');

  sw.network = () => fakeResponse({ url: `${sw.scope}src/main.js` });
  await sw.dispatchFetch({ url: `${sw.scope}src/main.js` });
  await flush();
  assert.equal(sw.puts.length, 1, 'la respuesta propia sí se cachea');

  assert.equal(sw.dispatchFetch({ url: `${sw.scope}x`, method: 'POST' }), null, 'no-GET no se intercepta');
});

/* ------------------------------------------------------------------ *
 * Utilidades
 * ------------------------------------------------------------------ */

function flipFirstByte(base64) {
  const bytes = fromBase64(base64);
  bytes[0] ^= 0xff;
  return Buffer.from(bytes).toString('base64');
}

/** Recalcula el checksum como lo haría un atacante que conoce el formato. */
async function reseal(envelope) {
  const header = [envelope.format, envelope.version, envelope.kdf, envelope.iterations,
    envelope.cipher, envelope.salt, envelope.iv].join('|');
  return { ...envelope, checksum: await sha256Hex(`${header}|${envelope.ciphertext}`) };
}

function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function flush() {
  return new Promise((done) => setTimeout(done, 0));
}

function fakeResponse({ url, type = 'basic', redirected = false, ok = true }) {
  return { url, type, redirected, ok, clone() { return this; } };
}

/** Ejecuta `public/sw.js` en un contexto aislado con `self`, `caches` y `fetch` simulados. */
function loadServiceWorker() {
  const scope = 'https://usuario.github.io/App-rutina-/';
  const listeners = {};
  const state = { scope, puts: [], network: () => fakeResponse({ url: scope }) };
  const cache = {
    match: async () => undefined,
    put: async (request) => { state.puts.push(request); },
    add: async () => {},
  };
  const context = {
    self: {
      location: new URL(`${scope}sw.js`),
      registration: { scope },
      addEventListener: (type, fn) => { listeners[type] = fn; },
    },
    caches: { open: async () => cache, keys: async () => [], delete: async () => true },
    fetch: async () => state.network(),
    Response,
    URL,
    Request,
    console,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(readFileSync(join(ROOT, 'public/sw.js'), 'utf8'), context);

  state.dispatchFetch = ({ url, method = 'GET', mode = 'cors' }) => {
    let responded = null;
    listeners.fetch({
      request: { url, method, mode },
      respondWith: (value) => { responded = Promise.resolve(value); },
    });
    return responded;
  };
  return state;
}
