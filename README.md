# RoutineTracker

PWA **offline-first** para el seguimiento de rutinas diarias. Sin backend, sin
frameworks, sin dependencias en tiempo de ejecución: HTML5 semántico, CSS
moderno y JavaScript con ES Modules nativos, servidos tal cual desde GitHub
Pages.

Todos los datos viven en el dispositivo (IndexedDB, con respaldo en
`localStorage`). No hay peticiones de red más allá de la descarga inicial de la
propia aplicación.

---

## Tabla de contenidos

- [Características](#características)
- [Agenda por día de la semana](#agenda-por-día-de-la-semana)
- [Ergonomía móvil: la zona del pulgar](#ergonomía-móvil-la-zona-del-pulgar)
- [Arquitectura](#arquitectura)
- [Estructura del repositorio](#estructura-del-repositorio)
- [Modelo de datos](#modelo-de-datos)
- [Algoritmo de racha resiliente](#algoritmo-de-racha-resiliente)
- [Interacción táctil](#interacción-táctil)
- [Rutas y GitHub Pages](#rutas-y-github-pages)
- [Desarrollo local](#desarrollo-local)
- [Pruebas](#pruebas)
- [Despliegue](#despliegue)
- [Compatibilidad y degradación](#compatibilidad-y-degradación)
- [Privacidad](#privacidad)
- [Seguridad client-side](#seguridad-client-side)

---

## Características

| Área | Detalle |
|---|---|
| Agenda | Bloques horarios **condicionales por día de la semana**: el martes hay turno de DiDi y clase, el viernes la ruta de la escuela, el fin de semana otra cosa |
| Contexto | Bloque en curso resuelto en tiempo real, destacado y desplegado solo, sin recargar la página |
| Ergonomía | Diseño para una sola mano: lectura arriba, **todas** las acciones en una barra inferior fija, hojas deslizantes en lugar de modales y objetivos táctiles de 48 px |
| Persistencia | IndexedDB `routine_tracker_db` v2 con tres *object stores* e índices; migración automática desde el `APP_STATE_V1` de la v1 |
| Rachas | Algoritmo resiliente con umbrales parciales, **escudos** (hasta 3) y puntuación de consistencia por media móvil exponencial |
| Corte de día | Detección de medianoche por comparación de clave de día, resistente a suspensión del dispositivo, pestañas en segundo plano y cambios de reloj |
| Gestos | Swipe → completar, swipe ← dispensar, con bloqueo de eje, fricción logarítmica, confirmación por distancia o velocidad y respuesta visual progresiva |
| Respuesta | UI optimista: el estado se pinta en el frame del gesto y se revierte si la escritura falla |
| Háptica | Patrones de vibración diferenciados por acción (Vibration API) |
| Pantalla | Screen Wake Lock opcional con re-adquisición automática |
| Visualización | Heatmap de 20 semanas dibujado en `<canvas>` con soporte de alta densidad y tema claro/oscuro |
| PWA | Manifest instalable, iconos *maskable*, Service Worker con estrategias diferenciadas y aviso de actualización |
| Datos | Copias de seguridad cifradas (AES-256-GCM + PBKDF2) con verificación SHA-256 al importar |
| Primer arranque | Rutina real precargada (13 tareas repartidas por la semana): la app se usa antes de configurarla |
| Robustez | Bloques plegables, aviso y congelación del cálculo diario si el reloj del dispositivo retrocede |
| Accesibilidad | Objetivos táctiles de 44 px, foco visible, `aria-live` en avisos, equivalentes textuales del heatmap, respeto por `prefers-reduced-motion` |

## Agenda por día de la semana

La rutina no es «mañana / tarde / noche»: es la agenda real, y cambia según el
día. Un bloque existe o no ese día, y puede tener horarios distintos según el
día.

| Día | Agenda |
|---|---|
| L, X, J | Arranque 04:30–08:30 · Jornada 09:00–14:00 · Comida 14:00–15:00 · Jornada 15:00–17:00 · Tiempo personal 17:00–23:00 · Desconexión 23:00–00:00 |
| **Martes** | …igual hasta las 17:00 · **DiDi 17:00–18:00** · Traslado 18:00–19:00 · **Clase 19:00–20:30** · Tiempo personal **20:30**–23:00 · Desconexión |
| **Viernes** | …igual hasta las 17:00 · **Traslado a la escuela 17:00–18:30** · **Clase 18:30–20:30** · Traslado a casa 20:30–21:30 · Cierre de semana 21:30–00:00 · Desconexión |
| Sábado | Mañana **05:00**–12:00 · Tarde libre 12:00–19:00 · Noche 19:00–00:00 · Desconexión |
| Domingo | Mañana **06:00**–12:00 · …igual que el sábado |

Tres reglas sostienen el motor (`src/domain/timeBlockService.js`):

1. **Un bloque se declara con reglas, no con un horario fijo.** Cada regla dice
   en qué días aplica y con qué horario, así que «Tiempo personal» empieza a
   las 17:00 los lunes y a las 20:30 los martes sin necesidad de duplicar el
   bloque.
2. **El bloque en curso es el más estrecho que contiene la hora.** Los rangos
   pueden solaparse a propósito: el viernes a las 23:30, «Cierre de semana»
   (21:30–00:00) y «Desconexión» (23:00–00:00) contienen el instante, y gana el
   segundo por ser más específico. Sin esta regla habría que recortar rangos a
   mano y declarar prioridades.
3. **Una tarea aplica si su `daysOfWeek` lo permite _y_ su bloque existe ese
   día.** La segunda condición evita el caso incoherente: una tarea marcada
   «todos los días» dentro del bloque de clase del martes no puede aparecer un
   jueves.

Consecuencias en la aplicación:

- **Filtrado estricto.** Lo que no aplica hoy no llega al DOM, y el servicio
  rechaza marcarlo aunque el comando llegue desde la consola.
- **Divisor honesto.** `completionRate` divide sólo entre las tareas
  aplicables: un lunes sin clase no penaliza por no haber ido a clase. El
  martes el divisor es 8; el sábado, 2.
- **Auto-enfoque en vivo.** Al dar las 19:00 de un martes, «Clase» pasa a estar
  en curso, se despliega sola y se destaca, sin recargar la página. El
  vigilante programa un temporizador al siguiente borde de bloque en lugar de
  sondear, con un tick de seguridad porque los temporizadores se congelan en
  segundo plano.

## Ergonomía móvil: la zona del pulgar

En un teléfono de 6,1"–6,7" sujetado con una mano, el pulgar barre cómodamente
el tercio inferior de la pantalla. La esquina superior opuesta exige recolocar
el agarre, que es justo el momento en que se cae el móvil. La interfaz reparte
la pantalla en consecuencia:

```
┌──────────────────────────────┐
│  CABECERA — sólo lectura     │  fecha · racha · anillo de progreso
│  (cero controles)            │  y el aviso de reloj desincronizado
├──────────────────────────────┤
│                              │
│  LISTA — bloques plegables   │  toda la rutina; sólo el bloque de la
│  swipe → completar           │  hora actual arranca desplegado
│  swipe ← dispensar           │
│                              │
├──────────────────────────────┤
│  📊 Histórico  (+)  ⚙️ Ajustes │  BARRA FIJA — todas las acciones
└──────────────────────────────┘  FAB de 56 px centrado; safe-area respetada
```

Decisiones que se derivan de ese reparto:

- **La cabecera no tiene ni un botón.** Una prueba end-to-end lo verifica
  (`headerControls === 0`): si alguien añade un control ahí, CI lo detecta.
- **Nada de modales centrados.** Alta y edición de tareas, ajustes e histórico
  se abren como **hoja inferior** (`bottomSheet.js`), arrastrable hacia abajo
  para cerrar. Con el teclado virtual desplegado, un modal centrado queda
  partido por la mitad; una hoja anclada abajo mantiene los controles pegados
  al borde del teclado.
- **48 px de objetivo táctil** en todo lo tocable (WCAG 2.2, criterio 2.5.8).
  Donde el elemento visible es menor —el círculo de completar mide 28 px— el
  área se amplía con un pseudoelemento sin agrandar el dibujo. La prueba e2e
  mide cada control y falla si alguno baja de 48.
- **Bloques plegables.** Una rutina completa son cuatro bloques y más de dos
  pantallas de scroll. A las ocho de la mañana, las tareas de la noche son
  ruido: arranca abierto sólo el bloque de la hora actual.

## Arquitectura

Cuatro capas con dependencias en **una sola dirección** (de arriba abajo):

```
┌─────────────────────────────────────────────────────────────┐
│  UI            renderer.js · components/* · styles/*        │
│                Sólo lee el store y despacha comandos.       │
├─────────────────────────────────────────────────────────────┤
│  Dominio       routineService · dayResetService             │
│                streakCalculator · taskValidator · selectors │
│                Funciones puras + servicios de aplicación.   │
├─────────────────────────────────────────────────────────────┤
│  Persistencia  repository → storageAdapter                  │
│                indexedDbService | localStorageService       │
├─────────────────────────────────────────────────────────────┤
│  Núcleo        store (estado reactivo) · events (bus)       │
│                constants · dateUtils                        │
└─────────────────────────────────────────────────────────────┘
        Plataforma: gestures · haptics · wakeLock (APIs nativas)
```

Reglas que sostienen el diseño:

1. **La UI no toca el almacenamiento.** Todo cambio entra por `RoutineService`,
   que valida, persiste, actualiza el store y sólo entonces emite el evento.
   Si la escritura falla, la interfaz no llega a mostrar un estado que no está
   guardado.
2. **El dominio no conoce el DOM.** `streakCalculator`, `taskValidator`,
   `dateUtils` y `selectors` son funciones puras: se ejecutan en Node y están
   cubiertas por pruebas sin navegador ni *mocks*.
3. **El motor de almacenamiento es intercambiable.** `repository` es lo único
   que conoce nombres de stores; cambiar IndexedDB por otro backend es
   implementar `StorageAdapter`.
4. **El estado es uno.** `store` es la única verdad en memoria y notifica en
   lotes agrupados por microtask: N mutaciones síncronas producen un render.

## Estructura del repositorio

```
routine-tracker/
├── .github/workflows/
│   ├── ci.yml                     # Pruebas, sintaxis y verificación del precaché
│   └── deploy.yml                 # Publicación en GitHub Pages
├── public/
│   ├── icons/                     # 192 · 512 · maskable 512 (generados)
│   ├── favicon.ico
│   ├── manifest.webmanifest
│   └── sw.js                      # Service Worker (implementación)
├── src/
│   ├── core/
│   │   ├── constants.js           # Configuración, enumeraciones y umbrales
│   │   ├── dateUtils.js           # Claves de día en hora local
│   │   ├── events.js              # EventBus pub/sub
│   │   └── store.js               # Estado reactivo centralizado
│   ├── domain/
│   │   ├── dayResetService.js     # Corte de medianoche y reconciliación
│   │   ├── routineService.js      # Servicio de aplicación (comandos)
│   │   ├── selectors.js           # Derivaciones puras del estado
│   │   ├── streakCalculator.js    # Rachas, escudos y consistencia
│   │   ├── taskValidator.js       # Contratos de datos y validación
│   │   └── timeBlockService.js    # Agenda por día y bloque en curso
│   ├── storage/
│   │   ├── indexedDbService.js    # Implementación primaria
│   │   ├── localStorageService.js # Respaldo con serialización JSON
│   │   ├── repository.js          # Fachada de dominio y migraciones
│   │   ├── seedData.js            # Rutina real precargada
│   │   └── storageAdapter.js      # Interfaz base
│   ├── security/
│   │   ├── cryptoService.js       # PBKDF2 + AES-GCM, sobres de backup cifrados
│   │   └── objectGuard.js         # JSON sin __proto__, deepFreeze, saneado profundo
│   ├── platform/
│   │   ├── gestures.js            # Reconocedor de swipe (Pointer Events)
│   │   ├── haptics.js             # Vibration API
│   │   └── wakeLock.js            # Screen Wake Lock API
│   ├── ui/
│   │   ├── components/            # header · taskList · taskItem · touchTaskItem
│   │   │                          # bottomBar · bottomSheet · taskEditor
│   │   │                          # settingsPanel · heatmap · toast
│   │   ├── styles/                # base.css · layout.css · components.css
│   │   ├── dom.js                 # Constructores de nodos sin innerHTML
│   │   └── renderer.js            # Montaje y suscripción al store
│   └── main.js                    # Punto de entrada
├── scripts/
│   ├── generate-icons.mjs         # Generador de PNG/ICO sin dependencias
│   ├── check-precache.mjs         # Coherencia de la lista del Service Worker
│   └── merge-to-main.sh           # Consolidación de la rama en main
├── tests/                         # Suite con el runner nativo de Node
│   └── e2e/smoke.mjs              # Prueba de humo opcional en Chromium
├── docs/SPEC.md                   # Especificación técnica exhaustiva
├── index.html                     # Shell de la aplicación
├── sw.js                          # Registro raíz (importScripts de public/sw.js)
└── package.json                   # Sólo scripts: no hay dependencias
```

> **Por qué hay un `sw.js` en la raíz.** El alcance de un Service Worker se
> limita al directorio desde el que se sirve, y GitHub Pages no permite enviar
> la cabecera `Service-Worker-Allowed` que lo ampliaría. El archivo raíz son
> tres líneas (`importScripts('./public/sw.js')`) que dan alcance completo a la
> aplicación manteniendo la implementación donde la sitúa la arquitectura.

## Modelo de datos

Base `routine_tracker_db`, versión **3**.

| Store | Clave primaria | Índices |
|---|---|---|
| `tasks` | `id` (UUID v4 o slug estable) | `idx_section` → `sectionId`, `idx_order`, `idx_archived` |
| `daily_logs` | `date` (`YYYY-MM-DD`) | `idx_completion_rate` |
| `system_metadata` | `key` | — |

```javascript
/**
 * @typedef {Object} TaskDefinition
 * @property {string} id               UUID v4 o slug estable (`task-tue-class`).
 * @property {string} title            Máx. 80 caracteres.
 * @property {string} sectionId        Identificador del bloque horario.
 * @property {number[]} daysOfWeek     Días activos (0 = domingo … 6 = sábado). Vacío = todos.
 * @property {string} [timeStart]      Hora de referencia "HH:mm".
 * @property {string} [timeEnd]        Hora de fin "HH:mm".
 * @property {boolean} isAnchor        Bloque rígido (trabajo, clase, traslado).
 * @property {number} order            Posición ordinal dentro del bloque.
 * @property {boolean} isArchived      Soft-delete.
 * @property {number} estimatedMinutes Se deduce del rango horario si no se declara.
 * @property {string} createdAt        ISO 8601.
 */

/**
 * @typedef {Object} DailyLog
 * @property {string} date                         Clave primaria.
 * @property {Object.<string, TaskExecutionRecord>} entries
 * @property {number} totalActiveTasks
 * @property {number} completedCount
 * @property {number} completionRate               0.0 – 1.0
 * @property {boolean} closed                      Procesado por el corte de medianoche.
 */
```

`system_metadata` guarda tres claves obligatorias: `streak_state`,
`user_preferences` y `schema_version`. El esquema completo, con invariantes y
matriz de migración, está en [`docs/SPEC.md`](docs/SPEC.md).

Decisiones que conviene conocer:

- **`isArchived` se indexa como `archivedFlag` (0/1).** IndexedDB no indexa
  booleanos; el repositorio mantiene el campo espejo y lo retira al leer.
- **Los agregados se recalculan al validar.** `completedCount` y
  `completionRate` nunca se leen del disco tal cual: se derivan de `entries`,
  de modo que un backup manipulado o un log de una versión previa no pueden
  inflar una racha.
- **Los identificadores de la semilla son legibles y estables.**
  `task-tue-class` en lugar de un UUID: así re-sembrar no duplica nada y los
  logs históricos siguen siendo interpretables al leerlos a mano.
- **`isAnchor` se hereda del bloque** cuando no se declara, y
  `estimatedMinutes` se deduce de `timeStart`/`timeEnd` cuando ambos están.

### Migración desde la v2

Los bloques genéricos de la v2 (`morning`, `afternoon`, `evening`, `anytime`)
no tienen equivalente en la agenda real: nadie declaró a qué hora eran. Sus
tareas se recogen en **«Cualquier momento»**, un bloque sin horario que existe
todos los días, desde donde se pueden reasignar. El índice `idx_section` se
borra y se recrea porque su `keyPath` cambió de `section` a `sectionId`, algo
que IndexedDB sólo permite dentro de una transacción de upgrade.

## Algoritmo de racha resiliente

Para un día `d` con `n_d` tareas computables (activas menos dispensadas) y
`c_d` completadas:

```
r_d = c_d / n_d                                     completionRate ∈ [0, 1]

           VOID     si n_d = 0
ω_d    =   SUCCESS  si r_d ≥ 0.8                    τ_success
           PARTIAL  si 0.5 ≤ r_d < 0.8              τ_partial
           FAIL     si r_d < 0.5
```

Transición de la racha `S` con escudos `E ∈ [0, 3]`:

| ω_d | Racha | Escudos |
|---|---|---|
| `SUCCESS` | `S + 1` | `+1` cada 7 días consecutivos (tope 3) |
| `PARTIAL` | `S` (gracia) | — |
| `FAIL` con `E > 0` | `S` | `−1`, `shieldsUsedTotal + 1` |
| `FAIL` con `E = 0` | `0` | — |
| `VOID` | `S` | — |

Consistencia ponderada (EWMA, ventana `W = 14`, `α = 2/(W+1)`):

```
C_d = α · 100·r_d + (1 − α) · C_{d−1}
```

El diseño responde a un problema real de las rachas clásicas: un único día malo
borra meses de trabajo, y el usuario abandona. Aquí un día a medias conserva la
racha sin premiarla, un día perdido consume un escudo que costó una semana
ganar, y el EWMA mantiene una señal de tendencia que no depende de la racha
para seguir siendo informativa.

Los días en que la aplicación no se abrió se reconcilian al arrancar: se
evalúan uno a uno en orden cronológico, tratando como `FAIL` los que tenían
tareas activas y como `VOID` los que no.

## Interacción táctil

| Gesto | Acción | Respuesta |
|---|---|---|
| Swipe → más del 35 % | Completar / descompletar | Fondo verde progresivo, icono de verificación que crece, vibración al cruzar el umbral |
| Swipe ← más del 35 % | Dispensar por hoy (sale del denominador) | Fondo ámbar progresivo, icono de omisión, vibración sutil |
| Toque en la fila | Alterna completado | Vibración corta |
| Toque en la cabecera del bloque | Pliega o despliega | Vibración corta |

- **Bloqueo de eje.** Al superar el umbral, el gesto elige eje horizontal o
  vertical y no lo reevalúa: un swipe diagonal dentro de una lista hace scroll,
  no descarta la tarea.
- **Confirmación por distancia o por velocidad.** Se confirma al 35 % del ancho
  o con un *fling* de 0,45 px/ms, lo que ocurra antes.
- **Fricción logarítmica** más allá del 50 % del ancho:
  `dx' = L + k·ln(1 + (|dx| − L)/k)`. El elemento sigue al dedo 1:1 mientras el
  gesto es informativo y luego se frena de forma asintótica: nunca hay un tope
  duro, pero arrastrar más deja de producir recorrido.
- **UI optimista.** El estado visual se aplica en el frame del gesto, antes de
  que resuelva la transacción de IndexedDB. Si la escritura falla, el servicio
  revierte el log y el siguiente render devuelve la fila a su sitio.
- **Sólo `transform`.** El arrastre no toca propiedades que disparen layout.

## Rutas y GitHub Pages

GitHub Pages publica el proyecto en `https://<usuario>.github.io/<repo>/`, no en
la raíz del dominio. Cualquier ruta absoluta (`/src/main.js`, `/sw.js`) apunta
fuera del despliegue y da 404. Reglas que sigue el repositorio:

| Elemento | Regla |
|---|---|
| `index.html` | Todo recurso con `./`; ninguna referencia empieza por `/` |
| Imports ES Modules | Siempre relativos entre módulos |
| Service Worker | `navigator.serviceWorker.register('./sw.js', { scope: './' })` |
| Precaché del SW | `ASSETS_TO_CACHE` son rutas relativas resueltas contra `self.registration.scope` |
| `manifest.webmanifest` | Vive en `public/`, así que sus rutas se resuelven **contra el manifest**: `start_url: "../index.html"` y `scope: "../"` apuntan a la raíz de la app |

> **Sobre el manifest.** Los campos `"./index.html"` y `"./"` sólo son correctos
> si el manifest está en la raíz. Desde `public/`, resolverían a
> `/<repo>/public/index.html` —que no existe— y a un *scope* que deja la
> aplicación fuera. `../` produce exactamente las URLs pretendidas:
> `/<repo>/index.html` y `/<repo>/`. La prueba `tests/deployPaths.test.js` fija
> esa resolución, y la end-to-end sirve la app bajo `/App-rutina-/` para
> comprobarlo en un navegador real.

## Desarrollo local

Basta un servidor estático: no hay compilación ni instalación de dependencias.
Los ES Modules exigen `http://`, no `file://`.

```bash
python3 -m http.server 8080       # o: npm run serve
```

Abre <http://localhost:8080>. El Service Worker sólo se registra en
`localhost` o bajo HTTPS.

Herramientas de depuración disponibles en la consola:

```js
__routineTracker.store.getState()          // estado completo
__routineTracker.repository.exportBackup() // volcado JSON
__routineTracker.dayReset.check('manual')  // forzar el corte de día
```

## Pruebas

```bash
npm test                          # o: node --test tests/*.test.js
```

161 pruebas sobre el runner nativo de Node, sin navegador ni dependencias:

| Archivo | Cubre |
|---|---|
| `dateUtils.test.js` | Claves de día en hora local, bisiestos, husos, parseo de `HH:mm` |
| `timeBlockService.test.js` | Agenda de cada día, bloque en curso, solapamientos, filtrado por día, vigilante horario |
| `taskValidator.test.js` | Contratos e invariantes del modelo, `daysOfWeek`, herencia de `isAnchor` |
| `streakCalculator.test.js` | Umbrales, escudos, reconciliación, EWMA |
| `gestures.test.js` | Máquina de estados del swipe, bloqueo de eje, fricción logarítmica |
| `deployPaths.test.js` | Ninguna ruta absoluta; resolución del manifest y del precaché bajo subdirectorio |
| `repository.test.js` | Persistencia, migración v1, siembra real, divisor por día, UI optimista y su reversión |
| `dayResetService.test.js` | Corte de medianoche, ausencias con divisor por agenda, reloj desincronizado |
| `security.test.js` | Payloads XSS renderizados como texto, cifrado/descifrado, clave errónea, sobres adulterados, JSON con `__proto__`, CSP y Service Worker |
| `events.test.js` | Bus de eventos y aislamiento de errores |

Comprobaciones adicionales en CI:

```bash
node scripts/check-precache.mjs   # el precaché del SW cubre todo src/
node scripts/generate-icons.mjs   # regenera iconos (deben quedar idénticos)
```

Prueba de humo end-to-end **opcional** (no corre en CI porque necesita
Playwright, que no es dependencia del proyecto):

```bash
npm install --no-save playwright && npx playwright install chromium
npm run test:e2e
```

Levanta su propio servidor estático **bajo un subdirectorio**
(`/App-rutina-/`, igual que GitHub Pages) y verifica en Chromium lo que el
runner de Node no alcanza:

- Semilla real: se renderizan exactamente las tareas que aplican hoy, ni una
  de otro día, y los bloques vacíos no llegan al DOM.
- Bloque en curso: como mucho uno destacado, desplegado y con su etiqueta.
- Editor: el selector de días deshabilita los que el bloque no cubre (elegir
  «Turno DiDi» deja sólo el martes).
- Ergonomía medida sobre el render real: barra anclada al borde inferior, FAB
  de 56 × 56, cabecera sin controles y **ningún objetivo táctil por debajo de
  48 px**.
- Bloques plegables: estado inicial, `aria-expanded` y plegado por toque.
- Hoja inferior: apertura, cierre por arrastre, cierre con Escape y `aria-modal`.
- Swipe de dispensar, UI optimista al completar, píxeles del heatmap.
- Service Worker: alcance `/App-rutina-/`, 37 recursos precacheados bajo esa
  ruta y arranque completo **sin conexión**.
- Manifest: `start_url`, `scope` e iconos resueltos dentro del subdirectorio.

## Despliegue

### Consolidar la rama de trabajo en `main`

Con el script incluido (comprueba el árbol limpio, ejecuta pruebas y
verificación de iconos, fusiona sin *fast-forward* y reintenta el push):

```bash
./scripts/merge-to-main.sh --dry-run    # enseña lo que haría, sin tocar nada
./scripts/merge-to-main.sh              # pide confirmación y publica
```

O a mano, que es exactamente lo mismo:

```bash
# 0. Árbol limpio y verificación previa
git status --porcelain                  # debe estar vacío
node --test tests/*.test.js
node scripts/check-precache.mjs

# 1a. Si `main` YA existe en el remoto
git fetch origin
git checkout main
git pull --ff-only origin main
git merge --no-ff claude/routinetracker-pwa-architecture-odvg33 \
  -m "merge: RoutineTracker PWA en main"
git push -u origin main

# 1b. Si `main` NO existe todavía (repositorio recién creado)
git push -u origin claude/routinetracker-pwa-architecture-odvg33:main
```

Ante un fallo de red, reintenta el push con espera creciente (2 s, 4 s, 8 s,
16 s). Nunca uses `--force` sobre `main`.

### Publicación

Cada `push` a `main` ejecuta `deploy.yml`: pruebas → verificación de iconos →
publicación del repositorio completo como artefacto de Pages. El workflow
activa Pages por sí mismo la primera vez (`configure-pages` con
`enablement: true`), así que no hay nada que configurar a mano.

> **Requisito de la cuenta.** GitHub Pages sólo está disponible en
> repositorios **públicos** o, si el repositorio es privado, con un plan de
> pago (GitHub Pro). En un repositorio privado de una cuenta gratuita el
> despliegue falla en `configure-pages` con
> `Get Pages site failed… verify that the repository has Pages enabled`.

No hay paso de compilación porque no hace falta: el repositorio *es* la
aplicación. Todas las rutas son relativas, así que funciona igual en la raíz de
un dominio que bajo `usuario.github.io/repositorio/`.

## Compatibilidad y degradación

| Capacidad | Ausente ⇒ |
|---|---|
| IndexedDB | Respaldo automático a `localStorage`; si tampoco existe, memoria de sesión con aviso explícito |
| Service Worker | La app funciona online con normalidad; no hay caché offline |
| Vibration API | Interruptor deshabilitado, explicando el motivo |
| Screen Wake Lock | Interruptor deshabilitado, explicando el motivo |
| `DOMMatrixReadOnly` | La hoja arrastrada a mitad de animación parte de cero en vez de su posición real |
| `color-mix()` | Los textos del swipe mantienen la tinta de la acción sin virar a blanco |
| `ResizeObserver` | El heatmap se redibuja con el evento `resize` |
| `CanvasRenderingContext2D.roundRect` | Trazado equivalente con `arcTo` |

Objetivo: navegadores con soporte de ES Modules nativos (Chrome/Edge 63+,
Firefox 60+, Safari 11+). La experiencia completa —instalación, gestos,
háptica— está pensada para Chromium en Android y Safari en iOS.

## Privacidad

No hay servidor, cuentas, analítica ni peticiones a terceros. Los datos se
quedan en el navegador y sólo salen del dispositivo si tú descargas una copia,
que siempre va cifrada. Borrar los datos del sitio borra la aplicación por
completo.

## Seguridad client-side

Sin backend no hay inyección SQL ni base de datos central que filtrar: la
superficie de ataque es el propio navegador. Las defensas, sin librerías:

| Capa | Medida |
|---|---|
| XSS | Ningún `innerHTML`/`outerHTML`/`document.write`/`eval`: todo el DOM se construye con `createElement` + `textContent` (`src/ui/dom.js`). Una prueba estática lo vigila en CI. |
| Entradas | `sanitizeText` normaliza a NFC y elimina controles C0/C1, secuencias ESC, overrides bidireccionales y espacios de ancho cero; título limitado a `LIMITS.TASK_TITLE_MAX`. |
| Prototype pollution | Todo JSON externo pasa por `safeJsonParse` (descarta `__proto__`, `constructor`, `prototype`); los catálogos globales están congelados en profundidad; el import sólo acepta claves de metadatos conocidas. |
| Copias | Sobre `{ format, version, kdf, iterations, cipher, salt, iv, ciphertext, checksum }`: PBKDF2-SHA-256 (100 000 iteraciones, salt de 16 B) → AES-256-GCM (IV de 12 B por operación), cabecera autenticada como AAD. El checksum SHA-256 se verifica antes de derivar la clave. Las copias en claro antiguas se siguen aceptando, revalidadas fila a fila. |
| CSP | Meta etiqueta con `default-src 'none'`, `script-src 'self'`, `connect-src 'self'`, `base-uri 'none'`, `form-action 'none'`, `object-src 'none'`. |
| Service Worker | Rechaza subrecursos de otro origen con error de red; sólo cachea respuestas `basic`, del mismo origen y sin redirección. |

Límites conocidos: el checksum SHA-256 sin clave detecta corrupción, pero es
la etiqueta GCM la que impide falsificar una copia. La base de datos local
(IndexedDB) **no** está cifrada en reposo: hacerlo exige pedir un PIN en cada
arranque. `frame-ancestors` y las cabeceras HTTP no se pueden fijar desde
GitHub Pages.

---

Licencia MIT.
