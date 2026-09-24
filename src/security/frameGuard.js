/*
 * Anti-clickjacking (framebusting) para un sitio que no puede enviar
 * `X-Frame-Options` ni `frame-ancestors`: GitHub Pages no admite cabeceras
 * propias y `frame-ancestors` se ignora en una meta CSP.
 *
 * Es un script CLÁSICO, síncrono y en el <head>, no un módulo: se ejecuta
 * antes de que se pinte el <body>. No va en línea porque la CSP
 * (`script-src 'self'`) bloquea los scripts inline, y abrirle la puerta con
 * 'unsafe-inline' debilitaría la defensa contra XSS mucho más de lo que esto
 * la refuerza.
 *
 * Si la página está enmarcada:
 *   1. Se oculta el documento ANTES de intentar nada: aunque la navegación
 *      del marco superior falle o tarde, no hay nada sobre lo que hacer clic.
 *   2. Se intenta sacar la app al marco superior.
 *   3. Si el sandbox lo impide, se detiene la carga del resto de recursos.
 *
 * Un iframe con `sandbox` sin `allow-scripts` no ejecuta este script, pero
 * tampoco la aplicación (que es un módulo JS): sólo quedaría el esqueleto HTML.
 */
(function frameGuard(win) {
  'use strict';
  var framed;
  try {
    framed = win.top !== win.self;
  } catch (error) {
    // Acceder a `top` desde un origen cruzado puede lanzar: eso ya es estar enmarcado.
    framed = true;
  }
  if (!framed) return;

  win.document.documentElement.style.display = 'none';
  try {
    win.top.location = win.self.location.href;
  } catch (error) {
    if (typeof win.stop === 'function') win.stop();
  }
}(window));
