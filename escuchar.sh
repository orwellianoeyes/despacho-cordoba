#!/bin/bash
# Deja la Mac escuchando el buzón: atiende los pedidos que llegan del panel.
# Ctrl+C para cortar.
set -u
REPO="$HOME/despacho-cordoba"
cd "$REPO" || { echo "No encuentro la carpeta $REPO"; exit 1; }

if [ ! -f "$REPO/.env" ]; then
  echo "Falta el archivo .env con las claves. Abortando."
  exit 1
fi
set -a; source "$REPO/.env"; set +a

exec "$REPO/.venv/bin/python" "$REPO/buzon.py" "$@"
