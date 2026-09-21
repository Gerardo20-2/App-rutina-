/**
 * Generador de iconos PWA y favicon, sin dependencias externas.
 *
 * Rasteriza el logotipo (cuadrado redondeado + anillo de progreso + check)
 * mediante funciones de distancia con supermuestreo 3×3 y codifica PNG con el
 * `zlib` de Node. Se ejecuta a mano cuando cambia la marca:
 *
 *     node scripts/generate-icons.mjs
 *
 * Los binarios resultantes se versionan en `public/icons/` para que GitHub
 * Pages no necesite ningún paso de compilación.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PALETTE = {
  bg: [47, 125, 89, 255],       // verde de marca
  bgDark: [26, 92, 63, 255],    // degradado inferior
  ring: [255, 255, 255, 64],
  mark: [255, 255, 255, 255],
};

/**
 * @param {number} size
 * @param {{padding?: number, radiusRatio?: number, contentScale?: number}} options
 *   `contentScale` encoge el anillo y el check dentro del fondo: los iconos
 *   maskable se recortan hasta un 20 % por borde, así que su contenido debe
 *   caber en la zona segura central.
 * @returns {Buffer} buffer RGBA de `size * size * 4`.
 */
function renderIcon(size, options = {}) {
  const padding = (options.padding ?? 0) * size;
  const box = { x0: padding, y0: padding, x1: size - padding, y1: size - padding };
  const radius = (options.radiusRatio ?? 0.22) * (box.x1 - box.x0);
  const cx = size / 2;
  const cy = size / 2;

  const contentScale = options.contentScale ?? 1;
  const span = (box.x1 - box.x0) * contentScale;
  const inner = { x0: cx - span / 2, y0: cy - span / 2 };

  const ringRadius = span * 0.32;
  const ringWidth = span * 0.075;

  // Trazo del check, en coordenadas normalizadas respecto al cuadro útil.
  const p1 = [inner.x0 + span * 0.33, inner.y0 + span * 0.52];
  const p2 = [inner.x0 + span * 0.45, inner.y0 + span * 0.65];
  const p3 = [inner.x0 + span * 0.69, inner.y0 + span * 0.37];
  const markWidth = span * 0.085;

  const data = Buffer.alloc(size * size * 4);
  const SS = 3; // supermuestreo por eje

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const sample = shade(px, py);
          r += sample[0]; g += sample[1]; b += sample[2]; a += sample[3];
        }
      }
      const n = SS * SS;
      const offset = (y * size + x) * 4;
      data[offset] = Math.round(r / n);
      data[offset + 1] = Math.round(g / n);
      data[offset + 2] = Math.round(b / n);
      data[offset + 3] = Math.round(a / n);
    }
  }
  return data;

  /** @returns {[number, number, number, number]} */
  function shade(px, py) {
    if (sdRoundedRect(px, py, box, radius) > 0) return [0, 0, 0, 0];

    // Fondo con degradado vertical.
    const t = (py - box.y0) / (box.y1 - box.y0);
    let color = mix(PALETTE.bg, PALETTE.bgDark, t);

    const ringDistance = Math.abs(Math.hypot(px - cx, py - cy) - ringRadius);
    if (ringDistance < ringWidth / 2) color = over(PALETTE.ring, color);

    const markDistance = Math.min(
      sdSegment(px, py, p1, p2),
      sdSegment(px, py, p2, p3),
    );
    if (markDistance < markWidth / 2) color = over(PALETTE.mark, color);

    return color;
  }
}

/** Distancia con signo a un rectángulo redondeado (negativa dentro). */
function sdRoundedRect(px, py, box, radius) {
  const halfW = (box.x1 - box.x0) / 2 - radius;
  const halfH = (box.y1 - box.y0) / 2 - radius;
  const dx = Math.abs(px - (box.x0 + box.x1) / 2) - halfW;
  const dy = Math.abs(py - (box.y0 + box.y1) / 2) - halfH;
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Distancia de un punto a un segmento. */
function sdSegment(px, py, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = px - a[0];
  const wy = py - a[1];
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
  return Math.hypot(wx - t * vx, wy - t * vy);
}

function mix(c1, c2, t) {
  const k = Math.max(0, Math.min(1, t));
  return [
    c1[0] + (c2[0] - c1[0]) * k,
    c1[1] + (c2[1] - c1[1]) * k,
    c1[2] + (c2[2] - c1[2]) * k,
    c1[3] + (c2[3] - c1[3]) * k,
  ];
}

/** Composición `source-over` de `src` sobre `dst`. */
function over(src, dst) {
  const alpha = src[3] / 255;
  return [
    src[0] * alpha + dst[0] * (1 - alpha),
    src[1] * alpha + dst[1] * (1 - alpha),
    src[2] * alpha + dst[2] * (1 - alpha),
    Math.max(src[3], dst[3]),
  ];
}

/* ------------------------------------------------------------------ *
 * Codificación PNG
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * @param {Buffer} rgba
 * @param {number} size
 * @returns {Buffer} PNG RGBA de 8 bits.
 */
function encodePng(rgba, size) {
  const stride = size * 4;
  // Cada scanline lleva su byte de filtro (0 = None).
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // profundidad de bits
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compresión deflate
  ihdr[11] = 0; // filtrado adaptativo
  ihdr[12] = 0; // sin entrelazado

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * ICO con carga útil PNG (soportado por todos los navegadores actuales).
 * @param {Buffer} png
 * @param {number} size
 */
function encodeIco(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reservado
  header.writeUInt16LE(1, 2); // tipo: icono
  header.writeUInt16LE(1, 4); // número de imágenes

  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0; // colores de paleta
  entry[3] = 0; // reservado
  entry.writeUInt16LE(1, 4);  // planos
  entry.writeUInt16LE(32, 6); // bits por píxel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);

  return Buffer.concat([header, entry, png]);
}

function write(relativePath, buffer) {
  const target = resolve(ROOT, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, buffer);
  console.log(`  ${relativePath} — ${(buffer.length / 1024).toFixed(1)} kB`);
}

console.log('Generando iconos…');
for (const size of [192, 512]) {
  write(`public/icons/icon-${size}.png`, encodePng(renderIcon(size), size));
}
// Maskable: el sistema recorta hasta un 20 % del borde, así que el contenido
// se reduce para caber en la "zona segura" circular.
write('public/icons/icon-maskable-512.png', encodePng(
  renderIcon(512, { radiusRatio: 0, contentScale: 0.66 }),
  512,
));
const favicon = renderIcon(32, { radiusRatio: 0.24 });
write('public/favicon.ico', encodeIco(encodePng(favicon, 32), 32));
console.log('Listo.');
