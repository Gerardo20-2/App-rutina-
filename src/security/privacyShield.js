/**
 * @module security/privacyShield
 * Pantalla de privacidad para el selector de apps (app switcher).
 *
 * Android e iOS guardan una miniatura de la app al pasarla a segundo plano, y
 * esa miniatura enseña la agenda y los hábitos a cualquiera que mire el
 * teléfono. Al perder visibilidad o foco se muestra, de forma **síncrona**
 * dentro del propio manejador del evento, una capa negra opaca sobre todo el
 * viewport y se desenfoca `#app`. Se retira sólo cuando la página vuelve a
 * estar visible Y la ventana recupera el foco.
 *
 * La capa se crea una vez al instalar y después sólo se conmuta el atributo
 * `data-privacy-shield` de `<html>`: mostrarla no reserva memoria ni construye
 * DOM en el momento crítico.
 *
 * Límite honesto: el navegador no promete en qué frame toma el sistema la
 * miniatura. En Chrome para Android `visibilitychange` suele llegar a tiempo;
 * en iOS, `pagehide`/`blur` ayudan pero no hay garantía. Es una mitigación.
 */

export const SHIELD_ID = 'privacy-shield';
export const SHIELD_ATTR = 'data-privacy-shield';

/**
 * @param {{doc?: Document, win?: Window}} [env] inyectables para pruebas.
 * @returns {{show: () => void, hide: () => void, readonly active: boolean, destroy: () => void}}
 */
export function installPrivacyShield({ doc = globalThis.document, win = globalThis.window } = {}) {
  const root = doc.documentElement;

  let shield = doc.getElementById?.(SHIELD_ID) ?? null;
  if (!shield) {
    shield = doc.createElement('div');
    shield.id = SHIELD_ID;
    shield.setAttribute('aria-hidden', 'true');
    doc.body.appendChild(shield);
  }
  // Estilos en línea además de los de `base.css`: si la hoja de estilos no ha
  // cargado todavía, la capa tapa igual.
  Object.assign(shield.style, {
    position: 'fixed',
    inset: '0',
    background: '#000000',
    zIndex: '2147483647',
    pointerEvents: 'all',
    display: 'none',
  });

  let active = false;

  function show() {
    if (active) return;
    active = true;
    shield.style.display = 'block';
    root.setAttribute(SHIELD_ATTR, 'on');
  }

  function hide() {
    if (!active) return;
    active = false;
    shield.style.display = 'none';
    root.removeAttribute(SHIELD_ATTR);
  }

  /** Visible y con foco: sólo entonces se retira la capa. */
  function restoreIfSafe() {
    const visible = doc.visibilityState === 'visible';
    const focused = typeof doc.hasFocus === 'function' ? doc.hasFocus() : true;
    if (visible && focused) hide();
  }

  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') show();
    else restoreIfSafe();
  };

  // `focus`/`blur` no burbujean, pero SÍ pasan por la fase de captura de
  // `window`: sin este filtro, salir de un campo de texto taparía la app.
  // Sólo cuenta el foco de la propia ventana.
  const onWindowBlur = (event) => {
    if (event.target === win) show();
  };
  const onWindowFocus = (event) => {
    if (event.target === win) restoreIfSafe();
  };

  const listeners = [
    [doc, 'visibilitychange', onVisibility],
    [win, 'pagehide', show],
    [win, 'blur', onWindowBlur],
    [win, 'focus', onWindowFocus],
    [win, 'pageshow', restoreIfSafe],
  ];
  // Fase de captura: se ejecuta antes que cualquier otro manejador.
  for (const [target, type, fn] of listeners) target.addEventListener(type, fn, true);

  return {
    show,
    hide,
    get active() {
      return active;
    },
    destroy() {
      for (const [target, type, fn] of listeners) target.removeEventListener(type, fn, true);
      hide();
    },
  };
}
