/**
 * Registro del Service Worker en la raíz de la aplicación.
 *
 * El alcance de un Service Worker se limita al directorio desde el que se
 * sirve, y GitHub Pages no permite enviar la cabecera `Service-Worker-Allowed`
 * que lo ampliaría. Este archivo de tres líneas existe para que el worker se
 * registre con alcance raíz mientras la implementación permanece en
 * `public/sw.js`, tal y como define la arquitectura del proyecto.
 */

importScripts('./public/sw.js');
