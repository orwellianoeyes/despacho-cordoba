#!/bin/bash
# Levanta el panel en local.
#
# La clave de Anthropic NO se copia acá: se toma del .env del repo padre y
# vive solo en el entorno de este proceso. Un secreto menos dando vueltas
# en archivos.
set -u
cd "$(dirname "$0")" || exit 1

if [ -f ../.env ]; then
  ANTHROPIC_API_KEY="$(grep -m1 '^ANTHROPIC_API_KEY=' ../.env | cut -d= -f2-)"
  export ANTHROPIC_API_KEY
fi

export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"   # Next 16 pide Node 20+
exec npm run dev
