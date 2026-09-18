#!/bin/bash
set -u

REPO="$HOME/despacho-cordoba"
cd "$REPO" || { echo "No encuentro la carpeta $REPO"; exit 1; }

LOG="$REPO/despacho.log"
exec >> "$LOG" 2>&1
echo ""
echo "===== $(date '+%Y-%m-%d %H:%M:%S') ====="

if [ -f "$REPO/.env" ]; then
  set -a
  source "$REPO/.env"
  set +a
else
  echo "Falta el archivo .env con las claves. Abortando."
  exit 1
fi

# Esperar a que haya conexión (la Mac recién despierta tarda en reconectar)
CONECTADO=0
for i in $(seq 1 20); do
  if curl -s --max-time 8 -o /dev/null https://github.com; then
    CONECTADO=1
    [ "$i" -gt 1 ] && echo "Conexión disponible tras $((i * 15)) segundos de espera."
    break
  fi
  [ "$i" -eq 1 ] && echo "Sin conexión todavía; esperando…"
  sleep 15
done

if [ "$CONECTADO" -eq 0 ]; then
  echo "No hubo conexión en 5 minutos. Se aborta; la próxima corrida reintenta."
  exit 1
fi

git pull --rebase --quiet || echo "Aviso: no pude hacer git pull, sigo igual."

# Motor, con reintentos
ESTADO=1
for intento in 1 2 3; do
  "$REPO/.venv/bin/python" "$REPO/boletin.py" "$@"
  ESTADO=$?
  if [ $ESTADO -eq 0 ]; then
    break
  fi
  if [ $intento -lt 3 ]; then
    echo "Intento $intento falló (código $ESTADO). Reintento en 2 minutos…"
    sleep 120
  fi
done

if [ $ESTADO -ne 0 ]; then
  echo "El motor falló en los 3 intentos. No se publica nada."
  exit $ESTADO
fi

mkdir -p docs/data texto
git add -A docs/data texto
if git diff --staged --quiet; then
  echo "Sin novedades para publicar."
else
  git commit -m "Despacho $(date '+%Y-%m-%d')" --quiet
  if git push --quiet; then
    echo "Publicado en GitHub."
  else
    echo "No pude publicar en GitHub (revisá la conexión o las credenciales)."
    exit 1
  fi
fi

echo "Listo."
