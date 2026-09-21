/**
 * @module ui/components/settingsPanel
 * Panel de preferencias y gestión de datos: háptica, Screen Wake Lock, tema y
 * export/import del volcado JSON.
 *
 * Los interruptores de capacidades nativas se deshabilitan cuando el
 * navegador no las expone y explican por qué: es preferible a un control que
 * no hace nada.
 */

import { h } from '../dom.js';

/**
 * @param {{
 *   onPreferenceChange: (patch: Object) => void,
 *   onExport: () => void,
 *   onImport: (file: File) => void,
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
    class: 'field__input', id: 'pref-theme',
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
      if (file) handlers.onImport(file);
      event.target.value = '';
    },
  });

  const engineEl = h('span', { class: 'settings__engine' });

  const el = h('section', { class: 'settings card', 'aria-labelledby': 'settings-title' }, [
    h('div', { class: 'card__head' }, [
      h('h2', { class: 'card__title', id: 'settings-title', text: 'Ajustes' }),
      engineEl,
    ]),
    hapticsToggle.el,
    wakeLockToggle.el,
    h('div', { class: 'field' }, [
      h('label', { class: 'field__label', for: 'pref-theme', text: 'Tema' }),
      themeSelect,
    ]),
    h('div', { class: 'settings__actions' }, [
      h('button', { class: 'btn', type: 'button', text: '⬇︎ Exportar datos', onClick: () => handlers.onExport() }),
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

  return { el, update, destroy() {} };
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
