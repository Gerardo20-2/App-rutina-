#!/usr/bin/env bash
#
# Consolida la rama de trabajo en `main` y publica.
#
#   scripts/merge-to-main.sh [--branch <rama>] [--dry-run] [--yes]
#
# Qué hace, en orden:
#   1. Comprueba que el árbol de trabajo está limpio.
#   2. Ejecuta la suite de pruebas y las comprobaciones estáticas.
#   3. Si `main` todavía no existe en el remoto, la crea a partir de esta rama.
#      Si existe, hace `merge --no-ff` para conservar la historia de la rama.
#   4. Empuja `main` con reintentos ante fallos de red.
#
# Lo que NO hace, a propósito: ni `--force`, ni reescribir historia, ni borrar
# la rama de trabajo. Un conflicto detiene el script y deja el repositorio tal
# cual para resolverlo a mano.
#
# Tras el primer despliegue hay que activar Pages una sola vez:
#   Settings → Pages → Source: «GitHub Actions».

set -euo pipefail

BRANCH="claude/routinetracker-pwa-architecture-odvg33"
TARGET="main"
DRY_RUN=0
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch) BRANCH="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Opción desconocida: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '   [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

# --- 1. Estado del repositorio ---------------------------------------------

say "Comprobando el árbol de trabajo"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Hay cambios sin confirmar. Haz commit o stash antes de fusionar." >&2
  git status --short >&2
  exit 1
fi

if ! git show-ref --verify --quiet "refs/heads/${BRANCH}"; then
  echo "La rama ${BRANCH} no existe en local." >&2
  exit 1
fi

say "Sincronizando con el remoto"
fetch_with_retry() {
  local delay=2
  for attempt in 1 2 3 4 5; do
    if git fetch origin --prune; then return 0; fi
    echo "   fetch fallido (intento ${attempt}), reintento en ${delay}s" >&2
    sleep "$delay"
    delay=$((delay * 2))
  done
  return 1
}
run fetch_with_retry

# --- 2. Verificación previa -------------------------------------------------

say "Ejecutando pruebas y comprobaciones"
run git checkout "$BRANCH"
run node --test tests/*.test.js
run node scripts/check-precache.mjs
run node scripts/generate-icons.mjs
if [[ $DRY_RUN -eq 0 ]] && ! git diff --quiet -- public/icons public/favicon.ico; then
  echo "Los iconos versionados no coinciden con el generador. Revisa y haz commit." >&2
  exit 1
fi

# --- 3. Fusión --------------------------------------------------------------

if git show-ref --verify --quiet "refs/remotes/origin/${TARGET}"; then
  say "Fusionando ${BRANCH} en ${TARGET}"
  if [[ $ASSUME_YES -eq 0 && $DRY_RUN -eq 0 ]]; then
    read -r -p "¿Fusionar ${BRANCH} en ${TARGET} y publicar? [s/N] " reply
    [[ "$reply" =~ ^[sSyY]$ ]] || { echo "Cancelado."; exit 0; }
  fi
  run git checkout "$TARGET"
  run git pull --ff-only origin "$TARGET"
  if ! run git merge --no-ff "$BRANCH" -m "merge: ${BRANCH} en ${TARGET}"; then
    echo "Conflicto de fusión. Resuélvelo, haz commit y vuelve a ejecutar el push:" >&2
    echo "  git push -u origin ${TARGET}" >&2
    exit 1
  fi
else
  say "${TARGET} no existe en el remoto: se crea a partir de ${BRANCH}"
  if [[ $ASSUME_YES -eq 0 && $DRY_RUN -eq 0 ]]; then
    read -r -p "¿Crear ${TARGET} desde ${BRANCH} y publicar? [s/N] " reply
    [[ "$reply" =~ ^[sSyY]$ ]] || { echo "Cancelado."; exit 0; }
  fi
  run git branch -f "$TARGET" "$BRANCH"
  run git checkout "$TARGET"
fi

# --- 4. Publicación ---------------------------------------------------------

say "Publicando ${TARGET}"
push_with_retry() {
  local delay=2
  for attempt in 1 2 3 4 5; do
    if git push -u origin "$TARGET"; then return 0; fi
    echo "   push fallido (intento ${attempt}), reintento en ${delay}s" >&2
    sleep "$delay"
    delay=$((delay * 2))
  done
  return 1
}
run push_with_retry

say "Listo"
cat <<'NEXT'
Siguientes pasos:
  · Settings → Pages → Source: «GitHub Actions» (sólo la primera vez).
  · El workflow deploy.yml publica en cada push a main.
  · La app quedará en https://<usuario>.github.io/<repo>/
NEXT
