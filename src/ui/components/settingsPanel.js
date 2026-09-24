/**
 * @module ui/components/settingsPanel
 * Panel de preferencias y gestión de datos: háptica, Screen Wake Lock, tema y
 * export/import de copias de seguridad cifradas.
 *
 * La frase de paso nunca se guarda: se lee como bytes en el momento de usarla
 * y el campo se sobrescribe y se vacía en el acto (`takeSecret`). El botón de
 * importar es también la única zona de la app que acepta archivos soltados.
 *
 * Los interruptores de capacidades nativas se deshabilitan cuando el
 * navegador no las expone y explican por qué: es preferible a un control que
 * no hace nada.
 */

import { h } from '../dom.js';
import { CRYPTO_CONFIG } from '../../security/cryptoService.js';
import { takeSecret, scrubSecretInput, makeJsonDropzone } from '../../security/inputGuard.js';

/**
 * @param {{
 *   onPreferenceChange: (patch: Object) => void,
 *   onExport: (passphrase: Uint8Array) => void,
 *   onImport: (file: File, passphrase: Uint8Array) => void,
 *   onWipe: () => void,
 *   capabilities: {haptics: boolean, wakeLock: boolean},
 * }} handlers
 */
export function createSettingsPanel(handlers) {
  const { capabilities } = handlers;

  const hapticsToggle = createToggle({
    id: 'pref-haptics',
    label: 'Vibración al completar',
    hint: capabilities.haptics ? 'Respuesta táctil en cada acción' : 'No disponible en este dispositivo',
    disabled: !capabilities.haptics,
    onChange: (checked) => handlers.onPreferenceChange({ hapticsEnabled: checked }),
  });

  const wakeLockToggle = createToggle({
    id: 'pref-wakelock',
    label: 'Mantener la pantalla encendida',
    hint: capabilities.wakeLock ? 'Útil mientras sigues la rutina' : 'No disponible en este navegador',
    disabled: !capabilities.wakeLock,
    onChange: (checked) => handlers.onPreferenceChange({ wakeLockEnabled: checked }),
  });

  const themeSelect = h('select', {
    class: 'field__input field__input--tap', id: 'pref-theme',
    onChange: (event) => handlers.onPreferenceChange({ theme: event.target.value }),
  }, [
    h('option', { value: 'system', text: 'Según el sistema' }),
    h('option', { value: 'light', text: 'Claro' }),
    h('option', { value: 'dark', text: 'Oscuro' }),
  ]);

  const fileInput = h('input', {
    type: 'file', accept: 'application/json,.json', class: 'sr-only', id: 'import-file',
    onChange: (event) => {
      const [file] = event.target.files ?? [];
      if (file) handlers.onImport(file, takeSecret(passphraseInput));
      event.target.value = '';
    },
  });

  const passphraseInput = h('input', {
    class: 'field__input', id: 'backup-passphrase', type: 'password',
    autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off',
    minlength: String(CRYPTO_CONFIG.PASSPHRASE_MIN), maxlength: '256',
    'aria-describedby': 'backup-passphrase-hint',
  });

  const engineEl = h('span', { class: 'settings__engine' });

  const importLabel = h('label', { class: 'btn', for: 'import-file', text: '⬆︎ Importar datos' });
  makeJsonDropzone(importLabel, (file) => {
    if (!unlockTimer) handlers.onImport(file, takeSecret(passphraseInput));
  });
  const lockStatus = h('p', { class: 'field__hint settings__lock', role: 'status', hidden: true });
  /** @type {ReturnType<typeof setInterval>|null} */
  let lockTimer = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let unlockTimer = null;

  // Sin cromo de tarjeta: el componente vive dentro de una hoja inferior, que
  // ya aporta título, fondo y bordes.
  const el = h('div', { class: 'settings' }, [
    h('p', { class: 'settings__storage' }, [
      h('span', { text: 'Almacenamiento: ' }),
      engineEl,
    ]),
    hapticsToggle.el,
    wakeLockToggle.el,
    h('div', { class: 'field' }, [
      h('label', { class: 'field__label', for: 'pref-theme', text: 'Tema' }),
      themeSelect,
    ]),
    h('div', { class: 'field' }, [
      h('label', { class: 'field__label', for: 'backup-passphrase', text: 'Frase de cifrado de la copia' }),
      passphraseInput,
      h('p', {
        class: 'field__hint', id: 'backup-passphrase-hint',
        text: `Mínimo ${CRYPTO_CONFIG.PASSPHRASE_MIN} caracteres. La copia se cifra con AES-256; sin esta frase no se puede recuperar.`,
      }),
    ]),
    h('div', { class: 'settings__actions' }, [
      h('button', {
        class: 'btn', type: 'button', text: '⬇︎ Exportar copia cifrada',
        onClick: () => handlers.onExport(takeSecret(passphraseInput)),
      }),
      importLabel,
      lockStatus,
      fileInput,
      h('button', {
        class: 'btn btn--danger', type: 'button', text: 'Borrar todo',
        onClick: () => handlers.onWipe(),
      }),
    ]),
  ]);

  /**
   * Bloquea la importación durante `ms` con cuenta atrás visible.
   * @param {number} ms
   */
  function setLockout(ms) {
    if (lockTimer) clearInterval(lockTimer);
    if (unlockTimer) clearTimeout(unlockTimer);
    const until = Date.now() + ms;
    // El desbloqueo va en su propio temporizador exacto; el intervalo sólo
    // refresca la cuenta atrás y con su granularidad de 1 s llegaría tarde.
    unlockTimer = setTimeout(() => {
      unlockTimer = null;
      unlock();
    }, ms);
    fileInput.disabled = true;
    importLabel.setAttribute('aria-disabled', 'true');
    importLabel.classList.add('is-disabled');
    lockStatus.hidden = false;
    const tick = () => {
      const left = Math.max(1, Math.ceil((until - Date.now()) / 1000));
      lockStatus.textContent = `Importación bloqueada por intentos fallidos: ${left} s`;
    };
    tick();
    lockTimer = setInterval(tick, 1000);
  }

  function unlock() {
    if (lockTimer) clearInterval(lockTimer);
    lockTimer = null;
    fileInput.disabled = false;
    importLabel.removeAttribute('aria-disabled');
    importLabel.classList.remove('is-disabled');
    lockStatus.hidden = true;
    lockStatus.textContent = '';
  }

  /** @param {import('../../core/store.js').AppState} state */
  function update(state) {
    hapticsToggle.set(state.preferences.hapticsEnabled);
    wakeLockToggle.set(state.preferences.wakeLockEnabled);
    if (themeSelect.value !== state.preferences.theme) themeSelect.value = state.preferences.theme;
    engineEl.textContent = describeEngine(state.ui.persistence);
    engineEl.dataset.engine = state.ui.persistence;
  }

  return {
    el,
    update,
    setLockout,
    clearPassphrase() {
      scrubSecretInput(passphraseInput);
    },
    destroy() {
      if (lockTimer) clearInterval(lockTimer);
      if (unlockTimer) clearTimeout(unlockTimer);
      scrubSecretInput(passphraseInput);
    },
  };
}

function createToggle({ id, label, hint, disabled, onChange }) {
  const input = h('input', {
    type: 'checkbox', id, class: 'switch__input', disabled,
    onChange: (event) => onChange(event.target.checked),
  });
  const el = h('div', { class: 'switch' }, [
    h('label', { class: 'switch__label', for: id }, [
      h('span', { class: 'switch__text' }, [
        h('span', { class: 'switch__title', text: label }),
        h('span', { class: 'switch__hint', text: hint }),
      ]),
      input,
      h('span', { class: 'switch__track', 'aria-hidden': 'true' }),
    ]),
  ]);
  return {
    el,
    set(value) {
      if (input.checked !== Boolean(value)) input.checked = Boolean(value);
    },
  };
}

function describeEngine(engine) {
  if (engine === 'indexeddb') return 'IndexedDB';
  if (engine === 'localstorage') return 'localStorage (respaldo)';
  if (engine === 'memory') return 'Sólo memoria — no persiste';
  return '';
}
