#!/bin/bash
# Respaldo de ~/proyectos (M5) hacia la Mac 2015: una carpeta por día, con
# enlaces duros contra la anterior, así que 7 días ocupan poco más que uno.
#
# Lo dispara launchd (com.leo.respaldo.plist) a las 23:00. La M5 es un
# portátil: si está dormida a esa hora, launchd lo corre al despertar.
#
#   Destino (en la 2015):  ~/respaldos/m5-proyectos/AAAA-MM-DD/
#   Enlace "actual":       ~/respaldos/m5-proyectos/actual -> el último
#   Log (en la M5):        ~/Library/Logs/respaldo-proyectos.log
#
# Incluye los .env a propósito (decidido el 11/10/2026): son claves que no
# existen en otro lado. La carpeta destino es 700. No incluye lo que se
# reconstruye solo: node_modules, .next, .venv, __pycache__.
set -u

ORIGEN="$HOME/proyectos/"
HOST="mac2015"
BASE="respaldos/m5-proyectos"       # relativo al home de la 2015
GUARDAR="${RESPALDO_GUARDAR:-7}"     # RESPALDO_* solo para probar a mano
LOG="$HOME/Library/Logs/respaldo-proyectos.log"
LOCK="$HOME/.respaldo-proyectos.lock"

mkdir -p "$(dirname "$LOG")"
exec >> "$LOG" 2>&1
echo ""
echo "===== $(date '+%Y-%m-%d %H:%M:%S') ====="

falla() {
  echo "FALLÓ: $1"
  osascript -e "display notification \"$1\" with title \"Respaldo de proyectos\"" 2>/dev/null
  exit 1
}

if ! mkdir "$LOCK" 2>/dev/null; then
  echo "Ya hay un respaldo en curso; salgo."
  exit 0
fi
trap 'rmdir "$LOCK"' EXIT

HOY="${RESPALDO_FECHA:-$(date +%F)}"

ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" true \
  || falla "No llego a la Mac 2015. Se reintenta en la próxima corrida."

HOME_REMOTO=$(ssh -o BatchMode=yes "$HOST" 'echo $HOME') || falla "No pude leer el home de la 2015."
ssh -o BatchMode=yes "$HOST" "mkdir -p '$BASE' && chmod 700 '$HOME_REMOTO/respaldos' '$BASE'" \
  || falla "No pude preparar la carpeta destino."

EXCLUIR=(--exclude node_modules --exclude .next --exclude .venv
         --exclude __pycache__ --exclude '*.pyc' --exclude .DS_Store)

# Si ya hay carpeta de hoy, se actualiza en el lugar. Si no, se arma aparte
# (.parcial) y se renombra al terminar: una copia a medias nunca parece buena.
if ssh -o BatchMode=yes "$HOST" "[ -d '$BASE/$HOY' ]"; then
  DEST="$BASE/$HOY"
  LINK=()
else
  PREVIO=$(ssh -o BatchMode=yes "$HOST" "ls -1 '$BASE' | grep -E '^20[0-9]{2}-[0-9]{2}-[0-9]{2}\$' | sort | tail -1")
  DEST="$BASE/$HOY.parcial"
  LINK=()
  [ -n "$PREVIO" ] && LINK=(--link-dest="$HOME_REMOTO/$BASE/$PREVIO")
fi

# ${LINK[@]+...}: con bash 3.2 (el de macOS) un arreglo vacío rompe bajo set -u
rsync -a --delete "${EXCLUIR[@]}" ${LINK[@]+"${LINK[@]}"} "$ORIGEN" "$HOST:$DEST/"
CODIGO=$?
# 24 = algún archivo desapareció mientras se copiaba (normal con un repo vivo)
if [ $CODIGO -ne 0 ] && [ $CODIGO -ne 24 ]; then
  falla "rsync terminó con código $CODIGO."
fi

if [ "$DEST" = "$BASE/$HOY.parcial" ]; then
  ssh -o BatchMode=yes "$HOST" "mv '$BASE/$HOY.parcial' '$BASE/$HOY'" \
    || falla "No pude cerrar la carpeta de hoy."
fi
ssh -o BatchMode=yes "$HOST" "ln -sfn '$HOY' '$BASE/actual'"

# Rotación: se quedan los GUARDAR más nuevos. Solo toca carpetas con nombre
# de fecha exacto, nada más.
ssh -o BatchMode=yes "$HOST" "cd '$BASE' && ls -1 | grep -E '^20[0-9]{2}-[0-9]{2}-[0-9]{2}\$' | sort -r | tail -n +$((GUARDAR + 1)) | while read d; do echo \"Rotación: borro \$d\"; rm -rf \"\$d\"; done"

echo "OK: $(ssh -o BatchMode=yes "$HOST" "du -sh '$BASE/$HOY' | cut -f1") en $BASE/$HOY"
