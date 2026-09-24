import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { Repository } from '../src/storage/repository.js';
import { LocalStorageService, MemoryBackend } from '../src/storage/localStorageService.js';
import { RoutineService } from '../src/domain/routineService.js';
import { DayResetService } from '../src/domain/dayResetService.js';
import { Store, createInitialState } from '../src/core/store.js';
import { EventBus } from '../src/core/events.js';
import { EVENTS, STORES, META_KEYS, SECURITY_CONFIG } from '../src/core/constants.js';
import { toDateKey, fromDateKey, addDays } from '../src/core/dateUtils.js';
import {
  encryptJson, decryptJson, wipeBuffer, assertPassphrase, CryptoError,
} from '../src/security/cryptoService.js';
import { IntegrityService, canonicalLogPayload } from '../src/security/integrityService.js';
import { AttemptLimiter, RateLimitError, penaltyFor, cryptoJitter } from '../src/security/rateLimiter.js';
import { installPrivacyShield, SHIELD_ID, SHIELD_ATTR } from '../src/security/privacyShield.js';
import {
  installDropGuard, makeJsonDropzone, copyPlainText, toPlainClipboardText, scrubSecretInput, takeSecret,
  DROPZONE_ATTR,
} from '../src/security/inputGuard.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PASSPHRASE = 'correcto caballo batería grapa';
const encode = (text) => new TextEncoder().encode(text);
const isZeroed = (bytes) => bytes.length > 0 && bytes.every((byte) => byte === 0);

/* ------------------------------------------------------------------ *
 * Utilidades
 * ------------------------------------------------------------------ */

async function makeRepository(backend = new MemoryBackend()) {
  const adapter = new LocalStorageService({ backend });
  const repository = new Repository({ adapter });
  await repository.open();
  return { repository, adapter, backend };
}

/** Log cerrado con una tarea completada: un día de éxito. */
function successLog(date) {
  return {
    date,
    entries: { 'task-wake-up': { completed: true, completedAt: `${date}T06:00:00.000Z`, skipped: false } },
    totalActiveTasks: 1,
    closed: true,
  };
}

function clockAt(dateKey) {
  const date = fromDateKey(dateKey);
  date.setHours(12, 0, 0, 0);
  return () => new Date(date);
}

/** Destino de eventos mínimo (window/document simulados). */
function makeTarget(extra = {}) {
  const listeners = new Map();
  return {
    ...extra,
    addEventListener(type, fn, capture) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      this.captures = [...(this.captures ?? []), Boolean(capture)];
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type, event = {}) {
      // Mismo objeto para todos los manejadores: `preventDefault` debe quedar visible.
      event.type = type;
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
    },
    count(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 1. Integridad HMAC de IndexedDB (sobre el backend en memoria)
 * ------------------------------------------------------------------ */

test('HMAC: cada log guardado lleva firma y la auditoría limpia no marca nada', async () => {
  const { repository, adapter } = await makeRepository();
  const today = toDateKey();
  await repository.saveLog(successLog(addDays(today, -1)));
  const row = await adapter.get(STORES.DAILY_LOGS, addDays(today, -1));
  assert.match(row.integritySig, /^[0-9a-f]{64}$/);
  assert.equal(repository.diagnostics.integrity, 'active');

  const report = await repository.auditIntegrity({ today });
  assert.deepEqual(report, { status: 'ok', tamperedDates: [], streakTampered: false });
});

test('HMAC: un log editado directamente en la base se detecta y se marca unverified', async () => {
  const { repository, adapter } = await makeRepository();
  const today = toDateKey();
  const day = addDays(today, -2);
  await repository.saveLog({ ...successLog(day), entries: {}, completedCount: 0 });

  // Edición «desde DevTools»: se infla el día sin pasar por el dominio.
  const row = await adapter.get(STORES.DAILY_LOGS, day);
  await adapter.put(STORES.DAILY_LOGS, { ...row, ...successLog(day) });

  const report = await repository.auditIntegrity({ today });
  assert.equal(report.status, 'tampered');
  assert.deepEqual(report.tamperedDates, [day]);
  assert.equal((await repository.getLog(day)).unverified, true);

  const again = await repository.auditIntegrity({ today });
  assert.deepEqual(again.tamperedDates, [], 'la marca persiste y no se re-notifica');
});

test('HMAC: logs inyectados sin firma o con la firma de otro día también se detectan', async () => {
  const { repository, adapter } = await makeRepository();
  const today = toDateKey();
  const a = addDays(today, -3);
  const b = addDays(today, -4);
  await repository.saveLog(successLog(a));
  const signedA = await adapter.get(STORES.DAILY_LOGS, a);

  await adapter.put(STORES.DAILY_LOGS, { ...successLog(addDays(today, -5)), completedCount: 1, completionRate: 1 });
  await adapter.put(STORES.DAILY_LOGS, { ...successLog(b), integritySig: signedA.integritySig });

  const report = await repository.auditIntegrity({ today });
  assert.deepEqual(report.tamperedDates.sort(), [addDays(today, -5), b].sort());
});

test('HMAC: la firma cubre las entradas, no sólo los agregados', async () => {
  const log = { date: '2026-09-20', entries: { 'task-a1': { completed: true, skipped: false } }, totalActiveTasks: 2, completedCount: 1, completionRate: 0.5, closed: true };
  const moved = { ...log, entries: { 'task-b1': { completed: true, skipped: false } } };
  assert.notEqual(canonicalLogPayload(log), canonicalLogPayload(moved));
});

test('HMAC: la marca unverified es pegajosa aunque se guarde encima un estado sin ella', async () => {
  const { repository, adapter } = await makeRepository();
  const today = toDateKey();
  const clean = await repository.saveLog({ date: today, entries: {}, totalActiveTasks: 3 });
  const row = await adapter.get(STORES.DAILY_LOGS, today);
  await adapter.put(STORES.DAILY_LOGS, { ...row, totalActiveTasks: 1, completedCount: 1 });
  await repository.auditIntegrity({ today });

  // El store aún tenía el log anterior a la auditoría, sin la marca.
  const saved = await repository.saveLog({ ...clean, closed: true });
  assert.equal(saved.unverified, true);
  assert.equal((await repository.getLog(today)).unverified, true);
});

test('HMAC: re-guardar un log manipulado (ensureLog al arrancar) no lo blanquea', async () => {
  const { repository, adapter } = await makeRepository();
  const today = toDateKey();
  await repository.ensureLog(today, 5);
  const row = await adapter.get(STORES.DAILY_LOGS, today);
  await adapter.put(STORES.DAILY_LOGS, { ...row, ...successLog(today), closed: false });

  // Sin auditoría previa: el re-sincronizado del total vuelve a guardar la fila.
  const resynced = await repository.ensureLog(today, 5);
  assert.equal(resynced.unverified, true, 'la fila con firma inválida no se re-firma como buena');
  assert.equal((await repository.getLog(today)).unverified, true);
});

test('HMAC: una racha inflada a mano se reconstruye desde los logs que verifican', async () => {
  const { repository, adapter } = await makeRepository();
  const today = toDateKey();
  for (const offset of [3, 2, 1]) await repository.saveLog(successLog(addDays(today, -offset)));
  const honest = await repository.rebuildStreak(today);
  assert.equal(honest.currentStreak, 3);
  await repository.saveStreak(honest);

  const row = await adapter.get(STORES.SYSTEM_METADATA, META_KEYS.STREAK_STATE);
  await adapter.put(STORES.SYSTEM_METADATA, { ...row, value: { ...row.value, currentStreak: 999, bestStreak: 999 } });

  const report = await repository.auditIntegrity({ today });
  assert.equal(report.streakTampered, true);
  const streak = await repository.getStreak();
  assert.equal(streak.currentStreak, 3);
  assert.equal(streak.bestStreak, 3);
  assert.equal(streak.lastEvaluatedDate, addDays(today, -1));
});

test('HMAC: la reconstrucción no da crédito a los días manipulados', async () => {
  const { repository, adapter } = await makeRepository();
  const today = toDateKey();
  for (const offset of [3, 2, 1]) await repository.saveLog(successLog(addDays(today, -offset)));
  const forged = await adapter.get(STORES.DAILY_LOGS, addDays(today, -1));
  await adapter.put(STORES.DAILY_LOGS, { ...forged, integritySig: 'f'.repeat(64) });
  const rebuilt = await repository.rebuildStreak(today);
  assert.ok(rebuilt.currentStreak < 3, `el día falsificado no puede sumar (racha ${rebuilt.currentStreak})`);
});

test('HMAC: el corte de medianoche ignora para la racha un día manipulado y avisa', async () => {
  const { repository, adapter } = await makeRepository();
  const store = new Store(createInitialState());
  const bus = new EventBus();
  const service = new RoutineService({ repository, store, bus });
  await service.hydrate();
  const day0 = store.getState().today;
  store.setState({
    streak: await repository.saveStreak({ ...(await repository.getStreak()), lastEvaluatedDate: addDays(day0, -1) }),
  });

  const row = await adapter.get(STORES.DAILY_LOGS, day0);
  await adapter.put(STORES.DAILY_LOGS, { ...row, ...successLog(day0), closed: false });

  const violations = [];
  const rolled = [];
  bus.on(EVENTS.INTEGRITY_VIOLATION, (payload) => violations.push(payload));
  bus.on(EVENTS.DAY_ROLLED, (payload) => rolled.push(payload));

  const reset = new DayResetService({ repository, store, bus, now: clockAt(addDays(day0, 1)) });
  assert.equal(await reset.check('test'), true);

  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0].tamperedDates, [day0]);
  const evaluation = rolled[0].evaluations.find((item) => item.date === day0);
  assert.ok(evaluation, 'el día se evalúa como ausencia');
  assert.notEqual(evaluation.outcome, 'SUCCESS');
  assert.equal(store.getState().streak.currentStreak, 0);
});

test('HMAC: si la clave desaparece no se re-firma nada (no se blanquean ediciones)', async () => {
  const backend = new MemoryBackend();
  const today = toDateKey();
  const first = await makeRepository(backend);
  await first.repository.saveLog(successLog(addDays(today, -1)));

  // Mismo almacenamiento de datos, almacén de secretos vacío: la clave se perdió.
  const second = await makeRepository(backend);
  assert.equal(second.repository.diagnostics.integrity, 'key-lost');
  const report = await second.repository.auditIntegrity({ today });
  assert.deepEqual(report.tamperedDates, [addDays(today, -1)]);
});

test('HMAC: datos previos a la integridad se firman en el primer uso (TOFU)', async () => {
  const adapter = new LocalStorageService({ backend: new MemoryBackend() });
  await adapter.init();
  const today = toDateKey();
  await adapter.put(STORES.DAILY_LOGS, { ...successLog(addDays(today, -1)), completedCount: 1, completionRate: 1 });
  const repository = new Repository({ adapter });
  await repository.open();
  assert.equal((await repository.auditIntegrity({ today })).status, 'ok');
});

test('HMAC: sin almacén de secretos (localStorage real) se desactiva sin falsos positivos', async () => {
  const map = new Map();
  const realLike = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
  const { repository, adapter } = await makeRepository(realLike);
  assert.equal(adapter.supportsSecrets, false);
  assert.equal(repository.diagnostics.integrity, 'unavailable');
  await repository.saveLog(successLog(addDays(toDateKey(), -1)));
  assert.equal((await repository.auditIntegrity()).status, 'unavailable');
  assert.equal((await repository.getLog(addDays(toDateKey(), -1))).unverified, undefined);
});

test('HMAC: el backup no exporta firmas ni claves, y lo importado se vuelve a firmar', async () => {
  const today = toDateKey();
  const source = (await makeRepository()).repository;
  await source.saveLog(successLog(addDays(today, -1)));
  const dump = await source.exportBackup();
  assert.ok(!JSON.stringify(dump).includes('integritySig'));
  assert.equal(dump.data[STORES.SECURITY_KEYS], undefined);

  const { repository, adapter } = await makeRepository();
  await repository.importBackup(dump);
  assert.match((await adapter.get(STORES.DAILY_LOGS, addDays(today, -1))).integritySig, /^[0-9a-f]{64}$/);
  assert.equal((await repository.auditIntegrity({ today })).status, 'ok');
});

test('HMAC: clave no exportable y verificación de firmas malformadas', async () => {
  const secrets = new Map();
  const integrity = new IntegrityService({
    secrets: { getSecret: async (n) => secrets.get(n), putSecret: async (n, k) => { secrets.set(n, k); } },
  });
  assert.deepEqual(await integrity.init(), { created: true });
  const [key] = secrets.values();
  assert.equal(key.extractable, false);
  assert.deepEqual(key.usages.sort(), ['sign', 'verify']);
  await assert.rejects(crypto.subtle.exportKey('raw', key));
  for (const bad of [undefined, 42, 'zz', 'a'.repeat(63), 'G'.repeat(64)]) {
    assert.equal(await integrity.verify('x', bad), false);
  }
  assert.deepEqual(await integrity.init(), { created: false }, 'la segunda vez reutiliza la clave');
});

/* ------------------------------------------------------------------ *
 * 2. Higiene de memoria
 * ------------------------------------------------------------------ */

test('wipeBuffer llama a fill(0) y pone a cero Uint8Array y ArrayBuffer', () => {
  const calls = [];
  wipeBuffer({ fill: (value) => calls.push(value) });
  assert.deepEqual(calls, [0]);
  const bytes = Uint8Array.from([1, 2, 3]);
  wipeBuffer(bytes);
  assert.deepEqual([...bytes], [0, 0, 0]);
  const raw = Uint8Array.from([9, 9]).buffer;
  wipeBuffer(raw);
  assert.deepEqual([...new Uint8Array(raw)], [0, 0]);
  assert.doesNotThrow(() => { wipeBuffer(null); wipeBuffer('texto'); });
});

test('memoria: cifrar pone a cero la frase y el texto en claro serializado', async () => {
  const passphrase = encode(PASSPHRASE);
  const original = Uint8Array.prototype.fill;
  const zeroFills = [];
  Uint8Array.prototype.fill = function spy(value, ...rest) {
    if (value === 0) zeroFills.push(this.length);
    return original.call(this, value, ...rest);
  };
  let envelope;
  try {
    envelope = await encryptJson({ secreto: 'Despertar a las 04:30' }, passphrase);
  } finally {
    Uint8Array.prototype.fill = original;
  }
  assert.ok(isZeroed(passphrase), 'la frase de paso quedó a cero');
  assert.ok(zeroFills.includes(passphrase.length), 'fill(0) sobre la frase');
  assert.ok(zeroFills.some((length) => length > passphrase.length), 'fill(0) sobre el texto en claro');
  assert.deepEqual(await decryptJson(envelope, encode(PASSPHRASE)), { secreto: 'Despertar a las 04:30' });
});

test('memoria: descifrar pone a cero la frase también cuando falla', async () => {
  const envelope = await encryptJson({ a: 1 }, PASSPHRASE);

  const right = encode(PASSPHRASE);
  await decryptJson(envelope, right);
  assert.ok(isZeroed(right));

  const wrong = encode('frase equivocada');
  await assert.rejects(decryptJson(envelope, wrong), { code: 'DECRYPT_FAILED' });
  assert.ok(isZeroed(wrong));

  const early = encode(PASSPHRASE);
  await assert.rejects(decryptJson({ ...envelope, checksum: '0'.repeat(64) }, early), { code: 'CHECKSUM_MISMATCH' });
  assert.ok(isZeroed(early), 'incluso si falla antes del KDF');

  const weak = encode('corta');
  await assert.rejects(encryptJson({}, weak), { code: 'WEAK_PASSPHRASE' });
  assert.ok(isZeroed(weak));
});

test('memoria: la longitud mínima cuenta caracteres, no bytes', () => {
  assert.throws(() => assertPassphrase(encode('ñññññññ')), CryptoError, '7 caracteres, 14 bytes');
  assert.doesNotThrow(() => assertPassphrase(encode('ññññññññ')));
});

test('memoria: una frase que no hacía falta (copia en claro) también se borra', async () => {
  const { repository } = await makeRepository();
  const passphrase = encode(PASSPHRASE);
  await repository.importBackup({ data: { tasks: [] } }, { passphrase });
  assert.ok(isZeroed(passphrase));
});

test('memoria: el campo de contraseña se sobrescribe con ruido antes de vaciarse', () => {
  const writes = [];
  let current = 'mi frase secreta';
  const input = {
    get value() { return current; },
    set value(next) { writes.push(next); current = next; },
  };
  const bytes = takeSecret(input);
  assert.equal(new TextDecoder().decode(bytes), 'mi frase secreta');
  assert.equal(writes.length, 2);
  assert.equal(writes[0].length, 'mi frase secreta'.length);
  assert.notEqual(writes[0], 'mi frase secreta');
  assert.equal(writes[1], '');

  writes.length = 0;
  scrubSecretInput(input);
  assert.deepEqual(writes, [''], 'un campo vacío no necesita ruido');
});

/* ------------------------------------------------------------------ *
 * 3. Freno de fuerza bruta
 * ------------------------------------------------------------------ */

test('backoff: tabla de penalizaciones', () => {
  assert.deepEqual([1, 2, 3].map((n) => penaltyFor(n)), Array(3).fill({ delayMs: 500, lockMs: 0 }));
  assert.deepEqual(penaltyFor(4), { delayMs: 0, lockMs: 5_000 });
  assert.deepEqual(penaltyFor(5), { delayMs: 0, lockMs: 30_000 });
  assert.deepEqual(penaltyFor(6), { delayMs: 0, lockMs: 60_000 });
  assert.deepEqual(penaltyFor(7), { delayMs: 0, lockMs: 120_000 });
  assert.equal(penaltyFor(60).lockMs, SECURITY_CONFIG.LOCK_MAX_MS, 'con techo');
});

/** Limitador con reloj falso: `sleep` avanza el reloj en lugar de esperar. */
function fakeLimiter(jitterValue = 0) {
  const clock = { t: 1_000_000, sleeps: [] };
  const limiter = new AttemptLimiter({
    now: () => clock.t,
    sleep: async (ms) => { clock.sleeps.push(ms); clock.t += ms; },
    jitter: () => jitterValue,
  });
  return { limiter, clock };
}

const fail = (code) => async () => { throw Object.assign(new Error(code), { code }); };

test('backoff: retardos y bloqueos progresivos ante intentos fallidos', async () => {
  const { limiter, clock } = fakeLimiter();
  const floor = SECURITY_CONFIG.FAILURE_FLOOR_MS;

  for (let n = 1; n <= 3; n += 1) {
    await assert.rejects(limiter.run(fail('DECRYPT_FAILED')), { code: 'DECRYPT_FAILED' });
    assert.equal(clock.sleeps.at(-1), floor + 500, `fallo ${n}: suelo + 500 ms`);
    assert.equal(limiter.remainingLockMs(), 0);
  }

  const fourth = await limiter.run(fail('DECRYPT_FAILED')).catch((error) => error);
  assert.equal(fourth.lockedForMs, 5_000);
  let attempted = false;
  const blocked = await limiter.run(async () => { attempted = true; }).catch((error) => error);
  assert.ok(blocked instanceof RateLimitError);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 5_000);
  assert.equal(attempted, false, 'durante el bloqueo ni siquiera se intenta descifrar');

  clock.t += 5_000;
  const fifth = await limiter.run(fail('CHECKSUM_MISMATCH')).catch((error) => error);
  assert.equal(fifth.lockedForMs, 30_000);

  clock.t += 30_000;
  const sixth = await limiter.run(fail('DECRYPT_FAILED')).catch((error) => error);
  assert.equal(sixth.lockedForMs, 60_000, '2^(6-5) × 30 s');

  clock.t += 60_000;
  const seventh = await limiter.run(fail('DECRYPT_FAILED')).catch((error) => error);
  assert.equal(seventh.lockedForMs, 120_000);

  clock.t += 120_000;
  assert.equal(await limiter.run(async () => 'ok'), 'ok');
  assert.equal(limiter.failures, 0, 'un acierto reinicia el contador');
});

test('backoff: tiempo de respuesta uniforme entre fallo de checksum y fallo de clave', async () => {
  const fast = fakeLimiter();
  await assert.rejects(fast.limiter.run(fail('CHECKSUM_MISMATCH')));
  const slow = fakeLimiter();
  await assert.rejects(slow.limiter.run(async () => {
    slow.clock.t += 400; // el KDF tardó 400 ms
    throw Object.assign(new Error('x'), { code: 'DECRYPT_FAILED' });
  }));
  assert.equal(fast.clock.t, slow.clock.t, 'ambos fallos terminan en el mismo instante');
});

test('backoff: errores que no son adivinanzas no cuentan, pero también se acolchan', async () => {
  const { limiter, clock } = fakeLimiter();
  for (let i = 0; i < 6; i += 1) await assert.rejects(limiter.run(fail('BAD_DUMP')));
  assert.equal(limiter.failures, 0);
  assert.equal(limiter.remainingLockMs(), 0);
  assert.ok(clock.sleeps.every((ms) => ms >= SECURITY_CONFIG.FAILURE_FLOOR_MS));
});

test('backoff: jitter del CSPRNG dentro de rango y sumado al bloqueo', async () => {
  for (let i = 0; i < 50; i += 1) {
    const value = cryptoJitter(250);
    assert.ok(Number.isInteger(value) && value >= 0 && value <= 250);
  }
  const { limiter } = fakeLimiter(123);
  for (let n = 1; n <= 3; n += 1) await assert.rejects(limiter.run(fail('DECRYPT_FAILED')));
  const error = await limiter.run(fail('DECRYPT_FAILED')).catch((e) => e);
  assert.equal(error.lockedForMs, 5_000 + 123);
});

test('backoff: importaciones fallidas reales bloquean el servicio y borran la frase', async () => {
  const { repository } = await makeRepository();
  const store = new Store(createInitialState());
  const bus = new EventBus();
  const { limiter } = fakeLimiter();
  const service = new RoutineService({ repository, store, bus, limiter });
  const envelope = JSON.stringify(await encryptJson({ data: { tasks: [] } }, PASSPHRASE));

  for (let n = 1; n <= 4; n += 1) {
    await assert.rejects(service.importBackup(envelope, { passphrase: encode(`intento ${n} erróneo`) }), { code: 'DECRYPT_FAILED' });
  }
  const passphrase = encode(PASSPHRASE);
  await assert.rejects(service.importBackup(envelope, { passphrase }), { code: 'RATE_LIMITED' });
  assert.ok(isZeroed(passphrase), 'la frase no usada por el bloqueo también se borra');
});

/* ------------------------------------------------------------------ *
 * 4. Pantalla de privacidad
 * ------------------------------------------------------------------ */

function makePrivacyEnv() {
  const attrs = new Map();
  const shieldEl = { style: {}, id: '', setAttribute() {} };
  const doc = makeTarget({
    visibilityState: 'visible',
    focused: true,
    hasFocus() { return this.focused; },
    documentElement: {
      setAttribute: (name, value) => attrs.set(name, value),
      removeAttribute: (name) => attrs.delete(name),
    },
    getElementById: () => null,
    createElement: () => shieldEl,
    body: { appendChild(el) { this.child = el; } },
  });
  const win = makeTarget();
  return { doc, win, attrs, shieldEl };
}

test('privacidad: la capa negra aparece al perder visibilidad o foco y sólo se retira con ambos', () => {
  const { doc, win, attrs, shieldEl } = makePrivacyEnv();
  const shield = installPrivacyShield({ doc, win });

  assert.equal(shieldEl.id, SHIELD_ID);
  assert.equal(doc.body.child, shieldEl);
  assert.equal(shieldEl.style.background, '#000000');
  assert.equal(shieldEl.style.zIndex, '2147483647');
  assert.equal(shieldEl.style.pointerEvents, 'all');
  assert.equal(shieldEl.style.display, 'none');
  assert.ok(doc.captures.every(Boolean) && win.captures.every(Boolean), 'fase de captura');

  doc.visibilityState = 'hidden';
  doc.dispatch('visibilitychange');
  assert.equal(shield.active, true);
  assert.equal(shieldEl.style.display, 'block', 'se muestra de forma síncrona en el manejador');
  assert.equal(attrs.get(SHIELD_ATTR), 'on', 'activa el desenfoque de #app');

  win.dispatch('focus', { target: win });
  assert.equal(shield.active, true, 'con la página oculta, el foco no basta');

  doc.visibilityState = 'visible';
  doc.focused = false;
  doc.dispatch('visibilitychange');
  assert.equal(shield.active, true, 'visible pero sin foco: sigue tapada');

  doc.focused = true;
  win.dispatch('focus', { target: win });
  assert.equal(shield.active, false);
  assert.equal(shieldEl.style.display, 'none');
  assert.equal(attrs.has(SHIELD_ATTR), false);

  // Un campo que pierde el foco pasa por la captura de window: no cuenta.
  win.dispatch('blur', { target: { tagName: 'INPUT' } });
  assert.equal(shield.active, false, 'el blur de un elemento no tapa la app');

  win.dispatch('blur', { target: win });
  assert.equal(shield.active, true, 'blur de la ventana');
  win.dispatch('pageshow');
  assert.equal(shield.active, false);
  win.dispatch('pagehide');
  assert.equal(shield.active, true, 'pagehide (iOS)');

  shield.destroy();
  assert.equal(shield.active, false);
  assert.equal(win.count('blur') + doc.count('visibilitychange'), 0, 'destroy quita los manejadores');
});

/* ------------------------------------------------------------------ *
 * 5. Anti-clickjacking
 * ------------------------------------------------------------------ */

function runFrameGuard({ framed, navigationThrows = false, topThrows = false }) {
  const log = { stopped: false, navigatedTo: null };
  const self = { location: { href: 'https://usuario.github.io/App-rutina-/' } };
  const top = {};
  Object.defineProperty(top, 'location', {
    set(value) {
      if (navigationThrows) throw new Error('SecurityError');
      log.navigatedTo = value;
    },
  });
  const window = {
    self,
    document: { documentElement: { style: {} } },
    stop() { log.stopped = true; },
  };
  Object.defineProperty(window, 'top', {
    get() {
      if (topThrows) throw new Error('SecurityError');
      return framed ? top : window;
    },
  });
  self.self = self;
  window.self = framed ? self : window;
  if (!framed) window.location = self.location;
  vm.runInNewContext(readFileSync(join(ROOT, 'src/security/frameGuard.js'), 'utf8'), { window });
  return { ...log, display: window.document.documentElement.style.display };
}

test('framebusting: fuera de un iframe no toca nada', () => {
  assert.deepEqual(runFrameGuard({ framed: false }), { stopped: false, navigatedTo: null, display: undefined });
});

test('framebusting: dentro de un iframe oculta la app y se escapa al marco superior', () => {
  const result = runFrameGuard({ framed: true });
  assert.equal(result.display, 'none', 'oculto antes de intentar navegar');
  assert.equal(result.navigatedTo, 'https://usuario.github.io/App-rutina-/');
});

test('framebusting: si el sandbox impide navegar, se detiene la carga y sigue oculta', () => {
  const result = runFrameGuard({ framed: true, navigationThrows: true });
  assert.equal(result.display, 'none');
  assert.equal(result.stopped, true);
  assert.equal(runFrameGuard({ framed: true, topThrows: true }).display, 'none', 'top inaccesible = enmarcada');
});

/* ------------------------------------------------------------------ *
 * 6. Drag-and-drop y portapapeles
 * ------------------------------------------------------------------ */

function dragEvent(target, files = []) {
  const event = {
    target,
    prevented: false,
    dataTransfer: { dropEffect: 'copy', files },
    preventDefault() { this.prevented = true; },
  };
  return event;
}

test('drop: se deniega en toda la ventana salvo en la zona de importación', () => {
  const win = makeTarget();
  const uninstall = installDropGuard({ win });
  const outside = { closest: () => null };
  const inside = { closest: (selector) => (selector === `[${DROPZONE_ATTR}]` ? {} : null) };

  for (const type of ['dragenter', 'dragover', 'drop']) {
    const denied = dragEvent(outside);
    win.dispatch(type, denied);
    assert.equal(denied.prevented, true, `${type} fuera de la zona`);
    assert.equal(denied.dataTransfer.dropEffect, 'none');

    const allowed = dragEvent(inside);
    win.dispatch(type, allowed);
    assert.equal(allowed.prevented, false, `${type} dentro de la zona`);
  }
  const bare = dragEvent({});
  win.dispatch('drop', bare);
  assert.equal(bare.prevented, true, 'destinos sin closest (texto, documento) también se deniegan');

  uninstall();
  assert.equal(win.count('drop'), 0);
});

test('drop: la zona de importación sólo acepta un único archivo JSON', () => {
  const zone = makeTarget({ attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } });
  const received = [];
  makeJsonDropzone(zone, (file) => received.push(file.name));
  assert.equal(zone.attrs[DROPZONE_ATTR], 'backup');

  const drop = (files) => {
    const event = dragEvent(zone, files);
    zone.dispatch('drop', event);
    return event.prevented;
  };
  assert.ok(drop([{ name: 'copia.encrypted.json', type: '' }]));
  drop([{ name: 'malware.exe', type: 'application/x-msdownload' }]);
  drop([{ name: 'pagina.html', type: 'text/html' }]);
  drop([{ name: 'a.json', type: 'application/json' }, { name: 'b.json', type: 'application/json' }]);
  drop([]);
  assert.deepEqual(received, ['copia.encrypted.json']);
});

test('portapapeles: sólo texto plano saneado vía writeText', async () => {
  const written = [];
  const clipboard = { writeText: async (text) => { written.push(text); } };
  const copied = await copyPlainText('Racha: 5‮\n<b>Agua</b>\u0000 ✓\r\n\u001b[31mfin', clipboard);
  assert.equal(copied, 'Racha: 5\n<b>Agua</b> ✓\n[31mfin');
  assert.deepEqual(written, [copied]);
  await assert.rejects(copyPlainText('x', undefined), /Portapapeles no disponible/);
  assert.equal(toPlainClipboardText(null), '');
});

/* ------------------------------------------------------------------ *
 * 7. Cableado en index.html y estilos
 * ------------------------------------------------------------------ */

test('index.html carga el framebuster como primer script, síncrono y tras la CSP', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const guard = html.indexOf('<script src="./src/security/frameGuard.js"></script>');
  assert.ok(guard > 0, 'script clásico sin async/defer/module');
  assert.ok(guard > html.indexOf('Content-Security-Policy'));
  assert.ok(guard < html.indexOf('<link'), 'antes de hojas de estilo y del módulo');
  assert.ok(guard < html.indexOf('type="module"'));
});

test('estilos de la pantalla de privacidad presentes', () => {
  const css = readFileSync(join(ROOT, 'src/ui/styles/base.css'), 'utf8');
  assert.match(css, /#privacy-shield\s*\{[^}]*background:\s*#000000;[^}]*z-index:\s*2147483647;[^}]*pointer-events:\s*all;/);
  assert.match(css, /html\[data-privacy-shield\] #app\s*\{\s*filter:\s*blur\(25px\);/);
});
