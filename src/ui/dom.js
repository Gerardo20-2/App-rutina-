/**
 * @module ui/dom
 * Utilidades mínimas de construcción de DOM. Sustituyen a `innerHTML` en todo
 * el proyecto: los títulos de tarea son texto del usuario y nunca se
 * interpolan como HTML.
 */

/**
 * @param {string} tag
 * @param {Object} [props] atributos, `class`, `dataset`, `style` y manejadores `onClick`.
 * @param {Array<Node|string|null|undefined>|Node|string} [children]
 * @returns {HTMLElement}
 */
export function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style') Object.assign(el.style, value);
    else if (key === 'text') el.textContent = String(value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

/**
 * @param {Node} parent
 * @param {Array<Node|string|null|undefined>|Node|string} children
 */
export function append(parent, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' || typeof child === 'number'
      ? document.createTextNode(String(child))
      : child);
  }
  return parent;
}

/**
 * Namespace SVG: `document.createElement` no sirve para elementos SVG.
 * @param {string} tag
 * @param {Object} [attrs]
 * @param {Array<Node>} [children]
 * @returns {SVGElement}
 */
export function svg(tag, attrs = {}, children = []) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    el.setAttribute(key, String(value));
  }
  for (const child of children) el.appendChild(child);
  return el;
}

/** @param {Node} node */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** `true` si el usuario pidió menos movimiento en el sistema operativo. */
export function prefersReducedMotion() {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
