# RoutineTracker — Especificación técnica del núcleo

> Documento de ingeniería del motor de RoutineTracker v2: contratos de datos,
> máquinas de estado, formulación matemática, presupuestos de rendimiento y
> matriz de pruebas. Describe **el código que existe en este repositorio**; cada
> sección enlaza con el módulo que la implementa.

**Versión de esquema:** 2 · **Dependencias externas:** ninguna ·
**Objetivo de ejecución:** navegadores con ES Modules nativos

---

## Índice

1. [Contratos de datos y tipado estricto](#1-contratos-de-datos-y-tipado-estricto)
2. [Esquema de persistencia](#2-esquema-de-persistencia)
3. [Migraciones](#3-migraciones)
4. [Algoritmo de racha resiliente](#4-algoritmo-de-racha-resiliente)
5. [Máquina de estados del corte de día](#5-máquina-de-estados-del-corte-de-día)
6. [Máquina de estados del reconocedor de gestos](#6-máquina-de-estados-del-reconocedor-de-gestos)
7. [Ciclo de vida del Service Worker](#7-ciclo-de-vida-del-service-worker)
8. [Contratos de módulo](#8-contratos-de-módulo)
9. [Taxonomía de errores](#9-taxonomía-de-errores)
10. [Presupuestos de rendimiento](#10-presupuestos-de-rendimiento)
11. [Matriz de pruebas](#11-matriz-de-pruebas)
12. [Decisiones de diseño y alternativas descartadas](#12-decisiones-de-diseño-y-alternativas-descartadas)

---

## 1. Contratos de datos y tipado estricto

El proyecto no usa TypeScript en tiempo de ejecución: la integridad se sostiene
sobre **JSDoc para la herramienta** y **validación en frontera para la
ejecución**. Todo dato que entra (import de backup, lectura de IndexedDB,
migración de la v1) y todo dato que sale hacia la persistencia atraviesa
`src/domain/taskValidator.js`.

### 1.1. `TaskDefinition`

```javascript
/**
 * @typedef {Object} TaskDefinition
 * @property {string} id               Identificador único UUID v4.
 * @property {string} title            Nombre legible de la tarea (máx 80 caracteres).
 * @property {'morning'|'afternoon'|'evening'|'anytime'} section Bloque del día.
 * @property {number} order            Posición ordinal para ordenamiento manual.
 * @property {number} estimatedMinutes Duración estimada de la tarea.
 * @property {boolean} isArchived      Flag para soft-delete.
 * @property {string} createdAt        Timestamp ISO 8601.
 */
```

| Campo | Invariante | Al violarse |
|---|---|---|
| `id` | `/^[0-9a-f]{8}-…-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i` | `ValidationError` |
| `title` | `1 ≤ length ≤ 80` tras recortar y colapsar espacios | `ValidationError` |
| `section` | Pertenece a `SECTION_ORDER` | `ValidationError` |
| `order` | Entero `≥ 0` | `ValidationError` |
| `estimatedMinutes` | `0 ≤ n ≤ 1440`, redondeado | `ValidationError` |
| `isArchived` | Coaccionado a booleano | — |
| `createdAt` | ISO 8601 parseable | `ValidationError` |

### 1.2. `TaskExecutionRecord` y `DailyLog`

```javascript
/**
 * @typedef {Object} TaskExecutionRecord
 * @property {boolean} completed       Estado de ejecución.
 * @property {string|null} completedAt Timestamp ISO 8601 o null.
 * @property {boolean} skipped         Dispensada mediante swipe-left.
 */

/**
 * @typedef {Object} DailyLog
 * @property {string} date             Clave primaria YYYY-MM-DD.
 * @property {Object.<string, TaskExecutionRecord>} entries Mapa taskId -> registro.
 * @property {number} totalActiveTasks Tareas computables para el día.
 * @property {number} completedCount   Tareas marcadas como completed.
 * @property {number} completionRate   completedCount / computables (0.0–1.0).
 * @property {boolean} closed          Procesado por el corte de medianoche.
 */
```

**Invariantes del log** (garantizadas por `validateDailyLog`):

| # | Invariante | Motivo |
|---|---|---|
| I1 | `skipped ⇒ !completed ∧ completedAt === null` | Dispensar y completar son excluyentes |
| I2 | `computables = totalActiveTasks − |{e : e.skipped}|` | Un skip no penaliza: sale del denominador |
| I3 | `completionRate = min(1, completedCount / computables)`, `0` si `computables = 0` | Evita división por cero y ratios > 1 |
| I4 | `completedCount` se **recalcula** desde `entries` si hay registros | Un backup manipulado no puede inflar la racha |
| I5 | Con `entries` vacío se acepta el `completedCount` declarado | Permite migrar logs agregados de la v1 |
| I6 | Las claves de `entries` son UUID v4 | Impide claves sintéticas de orígenes no fiables |

> **I4 e I5 no se contradicen**: la regla es "los registros mandan cuando
> existen". Un log migrado desde la v1 sólo tiene agregados, y perderlos
> equivaldría a borrar el historial del usuario en la actualización.

### 1.3. `StreakState`

```javascript
/**
 * @typedef {Object} StreakState
 * @property {number} currentStreak            Racha continua en días enteros.
 * @property {number} bestStreak               Máximo histórico alcanzado.
 * @property {number} shieldsAvailable         Escudos acumulados (entero, máx 3).
 * @property {number} shieldsUsedTotal         Total histórico de escudos consumidos.
 * @property {number} weightedConsistencyScore Puntuación flotante (0.0–100.0).
 * @property {string|null} lastEvaluatedDate   Última fecha procesada (YYYY-MM-DD).
 */
```

Saneado por `validateStreakState`, que **nunca lanza**: un estado de racha
corrupto no debe impedir abrir la aplicación. Se recorta a rango
(`shieldsAvailable ≤ 3`, `score ∈ [0,100]`), se fuerza `bestStreak ≥
currentStreak` y una fecha inválida pasa a `null`, que el reconciliador
interpreta como "primer arranque".

### 1.4. Claves de día

Todas las fechas de dominio son claves `YYYY-MM-DD` **en hora local**
(`src/core/dateUtils.js`). Usar UTC provocaría que, en husos negativos, marcar
una tarea a las 23:30 la contara en el día siguiente. `diffDays` normaliza a
mediodía antes de dividir, de modo que los cambios de horario de verano (±1 h)
no alteran el cociente.

---

## 2. Esquema de persistencia

**Base:** `routine_tracker_db` · **Versión:** `2` ·
Implementación: `src/storage/indexedDbService.js`.

### 2.1. Object stores

| Store | keyPath | Índices | Cardinalidad esperada |
|---|---|---|---|
| `tasks` | `id` | `idx_section` → `section`, `idx_order` → `order`, `idx_archived` → `archivedFlag` | 10¹–10² |
| `daily_logs` | `date` | `idx_completion_rate` → `completionRate` | 10²–10³ (1/día) |
| `system_metadata` | `key` | — | 3–5 |

`system_metadata` contiene obligatoriamente `'streak_state'`,
`'user_preferences'` y `'schema_version'`; `repository._ensureMetadata()` las
crea en cada apertura si faltan.

> **`idx_archived` apunta a `archivedFlag`, no a `isArchived`.** IndexedDB no
> admite booleanos como claves de índice. El repositorio escribe un espejo
> `archivedFlag ∈ {0,1}` y lo retira al leer, de forma que el modelo de dominio
> mantiene el booleano que declara el contrato.

### 2.2. Transacciones

`IndexedDbService.transaction()` resuelve en `oncomplete`, **no** cuando
resuelve la última petición: sólo entonces la escritura es durable. Si el
trabajo pasado como callback rechaza, la transacción se aborta explícitamente.

`importAll()` abre **una sola transacción sobre todos los stores**: un import
entra completo o no entra, sin estados intermedios.

### 2.3. Degradación del motor

```
IndexedDbService.isSupported()  ──sí──▶  IndexedDbService
        │ no                                   │ init() rechaza
        ▼                                      ▼
LocalStorageService  ◀──────────────────────────
        │ sin localStorage (modo privado, políticas)
        ▼
MemoryBackend  ──▶  engine === 'memory'  ──▶  aviso persistente en la UI
```

La sonda de IndexedDB abre y borra una base de prueba: Safari en modo privado
expone el objeto `indexedDB` pero falla al abrir, así que comprobar la
existencia de la API no basta.

---

## 3. Migraciones

### 3.1. Matriz de versiones

| Origen | Destino | Acción |
|---|---|---|
| — (instalación limpia) | 2 | Crear los tres stores y sus índices |
| IndexedDB v1 | 2 | Crear `daily_logs` y `system_metadata`; conservar `app_state` para la migración de datos |
| `localStorage:APP_STATE_V1` | 2 | `repository.migrateLegacy()` |
| Backup JSON (cualquier v2) | 2 | `repository.importBackup()` con validación previa |

La conversión de datos **no ocurre dentro de `onupgradeneeded`**: esa
transacción sólo admite API síncrona de IndexedDB, y la migración necesita
validar con el dominio. El upgrade crea el esquema; `migrateLegacy()` mueve los
datos después, con la base ya abierta.

### 3.2. `APP_STATE_V1` → esquema v2

| Origen v1 | Destino v2 | Regla |
|---|---|---|
| `tasks[].id` | `tasks.id` | Se reutiliza si es UUID v4; si no, se genera uno nuevo y se mapea |
| `tasks[].completed` | `daily_logs[lastActiveDate].entries[id]` | El día en curso conserva qué estaba marcado |
| `history[fecha]` | `daily_logs[fecha]` | `totalCount → totalActiveTasks`, `completedCount` se respeta (invariante I5), `closed = true` |
| `streak.current/best` | `system_metadata.streak_state` | `shields* = 0`, `score = 0` (la v1 no tenía estos conceptos) |
| `streak.lastCompletedDate` | `lastEvaluatedDate` | Si falta, `lastActiveDate − 1` |

Propiedades de la migración:

- **Idempotente.** La clave legada se elimina al terminar; una segunda pasada
  no encuentra nada que hacer.
- **No destructiva.** Las tareas sólo se importan si la base v2 está vacía, y
  los logs sólo si esa fecha no existe ya. Quien ya usó la v2 manda.
- **Tolerante.** Una tarea que no valida se descarta con aviso en consola; el
  resto de la migración continúa. Un JSON ilegible se descarta entero.

---

## 4. Algoritmo de racha resiliente

Implementación: `src/domain/streakCalculator.js` (funciones puras, sin reloj
propio ni acceso a almacenamiento).

### 4.1. Formulación

Para el día `d` con `n_d` tareas activas, `k_d` dispensadas y `c_d`
completadas:

```
m_d = n_d − k_d                          tareas computables
r_d = c_d / m_d          si m_d > 0      completionRate ∈ [0, 1]
r_d = 0                  si m_d = 0
```

Clasificación con `τ_s = 0.8` y `τ_p = 0.5`:

```
          VOID     si m_d = 0
ω_d  =    SUCCESS  si r_d ≥ τ_s
          PARTIAL  si τ_p ≤ r_d < τ_s
          FAIL     si r_d < τ_p
```

Transición del estado `(S, B, E, U, C)` — racha, mejor racha, escudos, escudos
consumidos, consistencia — con `E_max = 3` y `P = 7` (periodo de escudo):

```
ω_d = SUCCESS :  S' = S + 1
                 E' = min(E_max, E + 1)   si  S' ≡ 0 (mod P)
                 E' = E                    en otro caso
ω_d = PARTIAL :  S' = S,  E' = E
ω_d = FAIL    :  S' = S,  E' = E − 1,  U' = U + 1   si  E > 0
                 S' = 0,  E' = 0                     si  E = 0
ω_d = VOID    :  sin cambios

B' = max(B, S')
```

Consistencia ponderada, media móvil exponencial con ventana `W = 14`:

```
α   = 2 / (W + 1)  ≈ 0.1333
C_d = α · 100·r_d + (1 − α) · C_{d−1}          (C = 100·r en la primera muestra)
```

Los días `VOID` se saltan en el EWMA: no había nada que hacer, así que no
aportan información sobre la consistencia del usuario.

### 4.2. Propiedades

| # | Propiedad | Verificada en |
|---|---|---|
| P1 | Determinismo: misma entrada ⇒ misma salida, sin leer el reloj | Toda la suite |
| P2 | Monotonía de `bestStreak`: nunca decrece | `un fallo rompe la racha…` |
| P3 | Conservación de escudos: `E ∈ [0, 3]` y cada consumo incrementa `U` | `un escudo absorbe el fallo…` |
| P4 | Idempotencia de `reconcile` si `lastEvaluatedDate = hoy − 1` | `reconcile es idempotente…` |
| P5 | Acotación: `C ∈ [0, 100]` | `el EWMA converge…` |
| P6 | Terminación: `reconcile` procesa como mucho `MAX_RECONCILE_DAYS` (400) días | `reconcile trunca huecos absurdos…` |

### 4.3. Reconciliación de ausencias

`reconcile(state, logsByDate, throughDate, options)` evalúa en orden
cronológico `(lastEvaluatedDate, throughDate)` — extremos excluidos, porque
`throughDate` es el día abierto:

| Caso | Tratamiento |
|---|---|
| Existe log del día | Se aplica tal cual |
| No existe log y había tareas activas | `FAIL` con `r = 0` (consume escudo o rompe) |
| No existe log y no había tareas | `VOID` (neutro) |
| `lastEvaluatedDate === null` | Primer arranque: se ancla a `throughDate − 1`, sin evaluar |
| Hueco > 400 días | Se trunca a los últimos 400 y la racha se pone a 0 |

El truncado protege de un reloj del sistema alterado hacia el futuro: sin él,
un salto de 50 años produciría 18 250 iteraciones y un bloqueo del hilo
principal.

---

## 5. Máquina de estados del corte de día

Implementación: `src/domain/dayResetService.js`.

```
                 start()
      IDLE ───────────────▶ SCHEDULED
        ▲                       │
        │                       │ disparadores:
        │                       │  · setTimeout hasta la próxima medianoche
        │                       │  · visibilitychange (pestaña visible)
        │                       │  · focus / pageshow
        │                       │  · tick de seguridad cada 30 s
        │                       ▼
        │                 ┌── check() ──┐
        │        hoy = activo           hoy ≠ activo
        │                 │                   │
        │          _schedule()                ▼
        │                 │             EVALUATING ──── cierra el día abierto
        │                 │                   │          y lo aplica a la racha
        │                 │                   ▼
        │                 │            RECONCILING ──── aplica los días
        │                 │                   │          sin registro
        │                 │                   ▼
        └─────────────────┴──────────── IDLE + _schedule() → SCHEDULED
                                              │
                                        excepción
                                              ▼
                                           ERROR ── se reintenta en el
                                                     siguiente disparo
```

### 5.1. Por qué cuatro disparadores

Un `setTimeout` a medianoche **no basta**: los temporizadores se congelan
cuando la pestaña pasa a segundo plano o el dispositivo se suspende, y pueden
dispararse tarde o no dispararse. La detección real es la comparación de claves
de día; el temporizador es sólo el disparador más probable. Como `_rollover()`
es idempotente respecto a la fecha, cualquier combinación de disparos converge
al mismo resultado.

### 5.2. Casos límite

| Caso | Comportamiento |
|---|---|
| App cerrada varios días | `bootstrap` llama a `check()` antes de `start()`: el hueco se reconcilia en el arranque |
| Reloj adelantado | Se procesa el hueco; más de 400 días se trunca y rompe la racha |
| Reloj atrasado | No se reevalúa el pasado: sólo se reapunta el día activo y se recarga lo persistido |
| Dos disparos simultáneos | `_inFlight` serializa: el segundo espera al primero y no vuelve a evaluar |
| Fallo de escritura | Estado `ERROR`, evento `app:error`, reintento en el siguiente disparo |
| Medianoche con la app abierta y una tarea a medio arrastrar | El gesto se cancela al reconciliar la lista por clave; el día nuevo empieza limpio |

---

## 6. Máquina de estados del reconocedor de gestos

Implementación: `src/platform/gestures.js` (Pointer Events: un solo camino de
código para ratón, dedo y lápiz).

```
   IDLE ──pointerdown──▶ PRESSED
                            │
          ┌─────────────────┼──────────────────────┐
          │                 │                      │
   |dy| domina        |dx| > PAN_THRESHOLD    pointerup con
   y > TAP_SLOP       y |dx| ≥ |dy|          |d| ≤ TAP_SLOP
          │                 │                      │
          ▼                 ▼                      ▼
      REJECTED          PANNING                IDLE + onTap
    (scroll vertical)   (captura el
          │              puntero)
          │                 │
          │      ┌──────────┴───────────┐
          │      │                      │
          │  |dx| ≥ w·0.35          por debajo
          │  ó v ≥ 0.45 px/ms       del umbral
          │      │                      │
          │      ▼                      ▼
          │  SETTLING + onCommit   SETTLING + onCancel
          │      │                      │
          └──────┴──────────────────────┴──▶ IDLE

   pointercancel / lostpointercapture ──▶ SETTLING + onCancel ──▶ IDLE
```

| Parámetro | Valor | Razón |
|---|---|---|
| `TAP_SLOP` | 8 px | Por debajo, el movimiento es temblor del dedo, no arrastre |
| `PAN_THRESHOLD` | 12 px | Umbral de entrada en pan; menor produciría falsos positivos al hacer scroll |
| `COMMIT_RATIO` | 0.35 | Fracción del ancho que confirma la acción |
| `FLING_VELOCITY` | 0.45 px/ms | Permite confirmar con un gesto corto y rápido |
| `RUBBER_BAND` | 0.35 | Resistencia elástica pasado el punto de confirmación |
| `SETTLE_MS` | 180 ms | Duración del retorno; se anula con `prefers-reduced-motion` |

**Bloqueo de eje.** Una vez elegido el eje no se reevalúa durante el gesto. Sin
esta regla, un swipe diagonal en una lista vertical descartaría tareas mientras
el usuario intenta hacer scroll. El CSS declara `touch-action: pan-y` en el
ítem, de modo que el navegador cede el eje horizontal sin necesidad de
`preventDefault()` en cada `pointermove` (que además obligaría a registrar el
listener como no pasivo).

**Velocidad.** Media móvil exponencial `v ← 0.7·v_instantánea + 0.3·v` para
absorber el jitter de los últimos píxeles antes de levantar el dedo.

---

## 7. Ciclo de vida del Service Worker

Implementación: `public/sw.js`, registrado desde `sw.js` (raíz).

### 7.1. Alcance

El alcance de un Service Worker se limita al directorio desde el que se sirve,
y GitHub Pages no permite enviar `Service-Worker-Allowed`. El archivo raíz
—tres líneas con `importScripts('./public/sw.js')`— da alcance completo a la
aplicación sin mover la implementación. Las URLs relativas del worker se
resuelven contra la raíz, no contra `public/`.

### 7.2. Estrategias

| Tipo de petición | Estrategia | Motivo |
|---|---|---|
| Navegación (`mode === 'navigate'`) | Network-first con límite de 3 s → shell cacheado | Una versión nueva se ve al primer intento con red; sin red, la app abre igual |
| Estáticos del mismo origen | Stale-while-revalidate | Arranque instantáneo; la actualización llega al siguiente inicio |
| Cross-origin y no-GET | Passthrough | No se cachea lo que no se puede validar |

`install` precachea el shell con `cache.add` **por recurso**, no con `addAll`:
este último es atómico y un solo 404 abortaría la instalación completa.
`activate` borra los cachés de versiones anteriores, habilita *navigation
preload* y reclama los clientes. El mensaje `SKIP_WAITING` permite que el aviso
de "nueva versión disponible" active el worker en espera.

La coherencia de `PRECACHE_URLS` con el árbol real se verifica en CI
(`scripts/check-precache.mjs`): un precaché desincronizado es un fallo
silencioso que sólo se manifiesta sin conexión.

---

## 8. Contratos de módulo

### 8.1. `StorageAdapter`

```javascript
init(): Promise<void>
get(store, key): Promise<*|undefined>
getAll(store, query?): Promise<Array<*>>       // query: {index, range:{lower,upper}, limit}
put(store, value): Promise<*>
bulkPut(store, values): Promise<void>          // atómico
delete(store, key): Promise<void>
clear(store): Promise<void>
exportAll(): Promise<{version, exportedAt, data}>
importAll(dump): Promise<void>                 // atómico
close(): Promise<void>
static isSupported(): Promise<boolean>
get engine: 'indexeddb' | 'localstorage' | 'memory'
```

Ambas implementaciones cumplen el contrato al pie de la letra, incluida la
semántica de índices: `getAll(store, {index: 'idx_order'})` devuelve resultados
ordenados por esa clave en los dos motores.

### 8.2. `RoutineService` (comandos)

| Comando | Efecto | Evento emitido |
|---|---|---|
| `hydrate()` | Carga el estado persistido; siembra la rutina inicial en el primer arranque | `app:ready` |
| `toggleTask(id, force?)` | Alterna completado del día activo | `task:toggled` |
| `skipTask(id, force?)` | Dispensa la tarea (sale del denominador) | `task:skipped` |
| `saveTask(input)` | Alta o edición; re-sincroniza el total del log | `task:saved` |
| `archiveTask(id)` | Soft-delete | `task:archived` |
| `reorderTasks(ids)` | Reasigna `order` consecutivo | `tasks:reordered` |
| `setPreferences(patch)` | Persiste preferencias | — |
| `exportBackup()` / `importBackup(payload)` | Volcado JSON | — |
| `wipe()` | Borrado total y rehidratación | — |

**Orden invariante de todo comando: persistir → actualizar store → emitir
evento.** Si la escritura falla, el store no llega a mostrar un estado que no
está guardado.

### 8.3. `Store`

```javascript
getState(): AppState
setState(patch | (state) => patch): AppState   // comparación por Object.is
patch(key, partial): AppState                  // parche anidado de un nivel
subscribe(selector, listener, equals?): () => void
flush(): void                                  // entrega inmediata (pruebas)
```

Las notificaciones se agrupan en un microtask: tres `setState` síncronos
producen **un** render. El renderer usa una sola suscripción con el selector
identidad y reparte el estado a los componentes dentro de un
`requestAnimationFrame`.

### 8.4. Contrato de componente de UI

```javascript
create*(deps) -> { el: HTMLElement, update(state): void, destroy(): void }
```

El componente construye su DOM **una vez**; `update` sólo escribe texto y
atributos. `taskList` reconcilia por `task.id`: recrear los nodos destruiría el
reconocedor de gestos en pleno arrastre y reiniciaría las transiciones CSS.

Ningún componente usa `innerHTML`: los títulos de tarea son texto del usuario y
se insertan siempre como `textContent` (`src/ui/dom.js`).

---

## 9. Taxonomía de errores

| Clase | Código | Origen | Tratamiento |
|---|---|---|---|
| `ValidationError` | — (lleva `issues[]`) | Contratos de dominio | Se muestra en el formulario, campo a campo |
| `StorageError` | `OPEN_FAILED` | IndexedDB no abre | Degradación a `localStorage` |
| `StorageError` | `OPEN_REJECTED`, `BLOCKED` | Otra pestaña bloquea el upgrade | Aviso al usuario |
| `StorageError` | `TX_ERROR`, `TX_ABORTED`, `REQUEST_FAILED` | Transacción fallida | El comando se reporta como fallido; el store no se actualiza |
| `StorageError` | `QUOTA_EXCEEDED` | `localStorage` lleno | Aviso y sugerencia de exportar |
| `StorageError` | `BAD_DUMP` | Import inválido | Se rechaza sin tocar la base |
| `StorageError` | `NO_STORE`, `NO_KEY` | Error de programación | Falla ruidosamente |

Errores **deliberadamente silenciados**, porque su fallo es esperado y no
afecta a la corrección: `navigator.vibrate` (requiere interacción previa),
`wakeLock.request` (`NotAllowedError` con batería baja o pestaña oculta),
`setPointerCapture` y `Intl.DateTimeFormat` (con degradación a la clave ISO).

Los listeners del `EventBus` están aislados: uno que lanza no impide la entrega
al resto.

---

## 10. Presupuestos de rendimiento

| Métrica | Presupuesto | Cómo se consigue |
|---|---|---|
| Carga útil (sin comprimir) | < 120 kB | Sin dependencias; los iconos son el 60 % del peso |
| Peticiones en el arranque en frío | ≤ 25 | ES Modules directos, `modulepreload` del punto de entrada |
| Arranque en caliente (con SW) | 0 peticiones de red | Precaché del shell completo |
| Coste del render | Un `rAF` por lote de mutaciones | Agrupación en microtask + reconciliación por clave |
| Frame durante el arrastre | Sin layout | Sólo `transform`; `will-change: transform` en la capa móvil |
| Redibujado del heatmap | Una operación de canvas | 140 celdas en canvas en lugar de 140 nodos del DOM |
| Escrituras por toque | 1 `put` en `daily_logs` | El log del día es un único registro |

---

## 11. Matriz de pruebas

`npm test` → **68 pruebas** con el runner nativo de Node, sin navegador ni
dependencias.

| Archivo | Cubre | Casos destacados |
|---|---|---|
| `tests/dateUtils.test.js` | Claves de día locales | Medianoche en husos negativos, años bisiestos, fechas inexistentes, lunes = 0 |
| `tests/taskValidator.test.js` | Contratos e invariantes | I1–I6, saneado de rachas corruptas, rechazo de claves no-UUID, preferencias con claves ajenas |
| `tests/streakCalculator.test.js` | Algoritmo completo | Umbrales, tope de escudos a 28 días, reconciliación con y sin tareas activas, truncado a 400 días, convergencia del EWMA, proyección sin mutación |
| `tests/events.test.js` | EventBus | Aislamiento de errores, baja durante la emisión, `once`, `onAny` |
| `tests/repository.test.js` | Persistencia y servicio | Orden por bloque, soft-delete, export/import, import con registros corruptos, migración completa desde `APP_STATE_V1`, agrupación del store |
| `tests/dayResetService.test.js` | Corte de medianoche | Cierre y extensión, rotura, escudo, ausencia de 4 días, idempotencia, reloj hacia atrás, recarga del historial |

Comprobaciones estáticas en CI: `node --check` sobre todos los módulos, validez
del manifest, coherencia del precaché y reproducibilidad de los iconos
generados.

### 11.1. Prueba de humo end-to-end (opcional)

`tests/e2e/smoke.mjs` levanta un servidor estático con `node:http` y conduce
Chromium mediante Playwright. No corre en CI porque Playwright no es
dependencia del proyecto. Verifica nueve puntos que el runner de Node no
alcanza:

| # | Verificación |
|---|---|
| 1 | Arranque real: motor `IndexedDB` y siembra de la rutina inicial |
| 2 | Completar una tarea actualiza el anillo de progreso |
| 3 | El swipe izquierdo dispensa la tarea |
| 4 | Alta de tarea desde el botón flotante |
| 5 | El heatmap pinta píxeles reales en el canvas |
| 6 | Persistencia del estado tras recargar |
| 7 | Service Worker con alcance raíz y 34 recursos precacheados |
| 8 | Arranque completo **sin conexión** |
| 9 | Volcado de copia de seguridad con esquema 2 |

**Fuera de toda cobertura automática** (verificación manual en dispositivo):
háptica, Screen Wake Lock, instalación de la PWA y comportamiento del gesto
con un dedo real. Son capacidades que dependen del hardware y del permiso del
usuario; el código las trata como opcionales y degrada si faltan.

---

## 12. Decisiones de diseño y alternativas descartadas

| Decisión | Alternativa descartada | Motivo |
|---|---|---|
| IndexedDB con respaldo a `localStorage` | Sólo `localStorage` | El historial diario crece sin techo; `localStorage` es síncrono y limita a ~5 MB |
| Escudos y umbral parcial | Racha binaria clásica | Un solo día malo borra meses de trabajo y el usuario abandona |
| EWMA de consistencia | Media simple de 30 días | La media simple reacciona igual a lo de ayer que a lo del mes pasado |
| Corte por comparación de claves | `setTimeout` a medianoche | Los temporizadores se congelan en segundo plano y con el dispositivo suspendido |
| Canvas para el heatmap | 140 nodos del DOM | El coste de layout es visible en móviles de gama baja al redibujar |
| Pointer Events | Touch + Mouse por separado | Un único camino de código para dedo, ratón y lápiz |
| Reconciliación por clave | Re-render completo | Recrear el DOM destruye el gesto en curso y reinicia las animaciones |
| Sin framework | React/Preact/Lit | El alcance no lo justifica: el coste de descarga y el acoplamiento superan lo que aportan |
| Validación en frontera | Confianza en lo almacenado | Los datos vienen de backups editables a mano y de esquemas de versiones previas |
| `sw.js` raíz + implementación en `public/` | SW sólo en `public/` | Un SW servido desde `public/` no controla `/index.html`, y Pages no permite ampliar el alcance por cabecera |
