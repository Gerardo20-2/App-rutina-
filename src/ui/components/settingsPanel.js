/**
 * @module ui/components/settingsPanel
 * Panel de preferencias y gestión de datos: háptica, Screen Wake Lock, tema y
 * export/import de copias de seguridad cifradas.
 *
 * La frase de paso nunca se guarda: vive sólo en el campo mientras la hoja
 * está abierta y se borra tras cada uso correcto.
 *
 * Los interruptores de capacidades nativas se deshabilitan cuando el
 * navegador no las expone y explican por qué: es preferible a un control que
 * no hace nada.
 */

import { h } from '../dom.js';
import { CRYPTO_CONFIG } from '../../security/cryptoService.js';

/**
 * @param {{
 *   onPreferenceChange: (patch: Object) => void,
 *   onExport: (passphrase: string) => void,
 *   onImport: (file: File, passphrase: string) => void,
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
      if (file) handlers.onImport(file, passphraseInput.value);
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
        onClick: () => handlers.onExport(passphraseInput.value),
      }),
      h('label', { class: 'btn', for: 'import-file', text: '⬆︎ Importar datos' }),
      fileInput,
      h('button', {
        class: 'btn btn--danger', type: 'button', text: 'Borrar todo',
        onClick: () => handlers.onWipe(),
      }),
    ]),
  ]);

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
    clearPassphrase() {
      passphraseInput.value = '';
    },
    destroy() {
      passphraseInput.value = '';
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
