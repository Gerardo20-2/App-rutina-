/**
 * @module security/inputGuard
 * Entradas y salidas del sistema que no son el teclado: arrastrar y soltar,
 * y portapapeles.
 *
 *  - **Drop**: por defecto, soltar un archivo en una página hace que el
 *    navegador navegue a él (un .html arrastrado por error se abriría en el
 *    origen del archivo, un enlace arrastrado cargaría otra URL). Se cancela
 *    `dragover` y `drop` en toda la ventana salvo en las zonas marcadas con
 *    `data-dropzone`, que deciden qué aceptan.
 *  - **Portapapeles**: sólo texto plano saneado con `writeText`; nunca
 *    `text/html`, que otra aplicación podría interpretar como marcado.
 */

import { sanitizeText } from '../domain/taskValidator.js';

/** Atributo que marca una zona que sí acepta archivos soltados. */
export const DROPZONE_ATTR = 'data-dropzone';

/**
 * @param {*} target
 * @returns {Element|null} la zona permitida que contiene el destino.
 */
function dropzoneOf(target) {
  return target && typeof target.closest === 'function' ? target.closest(`[${DROPZONE_ATTR}]`) : null;
}

/**
 * Deniega drag-and-drop en toda la ventana excepto en las zonas permitidas.
 * @param {{win?: Window}} [env]
 * @returns {() => void} desinstalador.
 */
export function installDropGuard({ win = globalThis.window } = {}) {
  /** @param {DragEvent} event */
  const deny = (event) => {
    if (dropzoneOf(event.target)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
  };
  const types = ['dragenter', 'dragover', 'drop'];
  // Fase de captura: nada por debajo puede reactivar el comportamiento por defecto.
  for (const type of types) win.addEventListener(type, deny, true);
  return () => {
    for (const type of types) win.removeEventListener(type, deny, true);
  };
}

/**
 * Convierte en zona de soltado un elemento que acepta un único archivo JSON.
 * @param {HTMLElement} el
 * @param {(file: File) => void} onFile
 */
export function makeJsonDropzone(el, onFile) {
  el.setAttribute(DROPZONE_ATTR, 'backup');
  el.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  el.addEventListener('drop', (event) => {
    event.preventDefault();
    const files = [...(event.dataTransfer?.files ?? [])];
    // Un solo archivo y con pinta de JSON: ni carpetas, ni ejecutables, ni
    // URIs arrastradas desde otra pestaña.
    if (files.length !== 1) return;
    const [file] = files;
    if (!/\.json$/i.test(file.name) && file.type !== 'application/json') return;
    onFile(file);
  });
}

/**
 * Vacía un campo con un secreto sobrescribiéndolo antes con caracteres
 * aleatorios de la misma longitud. Es un esfuerzo de mejor intento: el motor
 * puede conservar copias de valores anteriores (historial de deshacer,
 * cadenas internas) y JavaScript no tiene forma de alcanzarlas.
 * @param {HTMLInputElement} input
 */
export function scrubSecretInput(input) {
  const length = input.value.length;
  if (length > 0) {
    const noise = globalThis.crypto.getRandomValues(new Uint8Array(length));
    input.value = Array.from(noise, (byte) => String.fromCharCode(33 + (byte % 94))).join('');
    noise.fill(0);
  }
  input.value = '';
}

/**
 * Lee un campo de secreto como bytes UTF-8 en NFC y lo vacía de inmediato. El
 * `string` intermedio es inevitable (`input.value` sólo devuelve cadenas) y
 * no se puede borrar; el resto del recorrido va en un buffer que el servicio
 * criptográfico pone a cero al terminar.
 * @param {HTMLInputElement} input
 * @returns {Uint8Array}
 */
export function takeSecret(input) {
  const bytes = new TextEncoder().encode(input.value.normalize('NFC'));
  scrubSecretInput(input);
  return bytes;
}

/**
 * Sanea texto multilínea para el portapapeles: cada línea pasa por
 * `sanitizeText` (sin controles, ESC ni overrides bidi) y se conservan los
 * saltos de línea.
 * @param {*} text
 * @returns {string}
 */
export function toPlainClipboardText(text) {
  return String(text ?? '')
    .split(/\r\n|\r|\n/)
    .map((line) => sanitizeText(line))
    .join('\n')
    .trim();
}

/**
 * Copia texto plano. Nunca usa `document.execCommand('copy')` ni
 * `ClipboardItem` con HTML.
 * @param {*} text
 * @param {Clipboard} [clipboard]
 * @returns {Promise<string>} el texto efectivamente copiado.
 */
export async function copyPlainText(text, clipboard = globalThis.navigator?.clipboard) {
  if (!clipboard || typeof clipboard.writeText !== 'function') {
    throw new Error('Portapapeles no disponible');
  }
  const plain = toPlainClipboardText(text);
  await clipboard.writeText(plain);
  return plain;
}
