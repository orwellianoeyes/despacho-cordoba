#!/bin/bash
# Vigilante de la Mac 2015. Cada 5 minutos mira tres cosas y le avisa a Leo por
# Telegram cuando CAMBIA alguna (no repite mientras siga igual):
#
#   luz     AC / BAT (pasó a batería) / BAJA (batería <= BAT_MIN y sin luz)
#   bot     el servicio de trading corre Y su log se escribió hace poco
#   buzón   el servicio del buzón corre
#
# Un cambio solo se avisa si se repite en dos corridas seguidas: un parpadeo de
# luz de 3 segundos (pasó el 08/10) no genera mensaje.
#
# IMPORTANTE: cuando se corta la luz también se va el router, así que el aviso
# no puede salir en ese momento. Cada aviso se guarda con SU hora en
# ~/.vigilante/pendientes y se entrega junto con los demás apenas vuelve la
# conexión. Llega "11:47 pasó a batería ... 14:27 volvió la luz", ya terminado.
#
# Probar sin mandar nada:  vigilante.sh --probar
#   (VIG_DIR=/carpeta/temporal y VIG_LUZ / VIG_PCT / VIG_BOT / VIG_BUZON
#    simulan lecturas)
set -u

REPO="$HOME/despacho-cordoba"
BOT="$HOME/bot traiding"
DIR="${VIG_DIR:-$HOME/.vigilante}"
PEND="$DIR/pendientes"
BAT_MIN=40            # % de batería bajo el cual, sin luz, se avisa
BOT_SILENCIO=600      # segundos sin escribir en el log para dar al bot por caído
MAX_PEND=30           # tope de avisos acumulados
PROBAR=0; [ "${1:-}" = "--probar" ] && PROBAR=1

mkdir -p "$DIR" && chmod 700 "$DIR"
UID_=$(id -u)
ahora() { date '+%d/%m %H:%M'; }

# ---------- lecturas ----------
leer_luz() {
  if [ -n "${VIG_LUZ:-}" ]; then LUZ="$VIG_LUZ"; PCT="${VIG_PCT:-100}"; else
    local b; b=$(pmset -g batt 2>/dev/null)
    PCT=$(echo "$b" | grep -oE '[0-9]+%' | head -1 | tr -d '%'); PCT=${PCT:-100}
    case "$b" in *"Battery Power"*) LUZ=BAT ;; *) LUZ=AC ;; esac
  fi
  if [ "$LUZ" = "BAT" ] && [ "$PCT" -le "$BAT_MIN" ]; then LUZ=BAJA; fi
}
leer_bot() {
  if [ -n "${VIG_BOT:-}" ]; then BOTV="$VIG_BOT"; return; fi
  BOTV=CAIDO
  launchctl print "gui/$UID_/com.leo.bottrading" 2>/dev/null | grep -q "state = running" || return
  local m; m=$(stat -f %m "$BOT/user_data/logs/dryrun.log" 2>/dev/null) || return
  [ $(( $(date +%s) - m )) -lt "$BOT_SILENCIO" ] && BOTV=OK
}
leer_buzon() {
  if [ -n "${VIG_BUZON:-}" ]; then BUZV="$VIG_BUZON"; return; fi
  BUZV=CAIDO
  launchctl print "gui/$UID_/com.leo.buzon" 2>/dev/null | grep -q "state = running" && BUZV=OK
}

# ---------- confirmación en dos corridas ----------
# confirmar <señal> <valor actual>  ->  imprime "anterior" si el cambio quedó
# confirmado en esta corrida; no imprime nada si no hay cambio confirmado.
confirmar() {
  local s="$1" c="$2" p q n
  p=$(cat "$DIR/$s.p" 2>/dev/null)
  if [ -z "$p" ]; then echo "$c" > "$DIR/$s.p"; return; fi      # primera vez: línea base
  if [ "$c" = "$p" ]; then rm -f "$DIR/$s.q" "$DIR/$s.n"; return; fi
  q=$(cat "$DIR/$s.q" 2>/dev/null); n=$(cat "$DIR/$s.n" 2>/dev/null); n=${n:-0}
  if [ "$c" = "$q" ]; then n=$((n + 1)); else q="$c"; n=1; fi
  if [ "$n" -ge 2 ]; then
    echo "$c" > "$DIR/$s.p"; rm -f "$DIR/$s.q" "$DIR/$s.n"; echo "$p"
  else
    echo "$q" > "$DIR/$s.q"; echo "$n" > "$DIR/$s.n"
  fi
}
anotar() { echo "[$(ahora)] $1" >> "$PEND"; }

leer_luz; leer_bot; leer_buzon

A=$(confirmar luz "$LUZ")
if [ -n "$A" ]; then
  case "$LUZ" in
    AC)   anotar "🔌 Volvió la luz (batería $PCT%)." ;;
    BAT)  [ "$A" = "AC" ] && anotar "⚡ Pasó a batería ($PCT%): posible corte de luz." \
                           || anotar "🔋 Sigue sin luz, batería $PCT%." ;;
    BAJA) anotar "🪫 Batería baja: $PCT% y sin luz. Si se apaga, nada arranca solo (FileVault)." ;;
  esac
fi
A=$(confirmar bot "$BOTV")
if [ -n "$A" ]; then
  [ "$BOTV" = "OK" ] && anotar "🤖 El bot de trading volvió a funcionar." \
                     || anotar "🤖 El bot de trading no está corriendo o dejó de escribir su log."
fi
A=$(confirmar buzon "$BUZV")
if [ -n "$A" ]; then
  [ "$BUZV" = "OK" ] && anotar "📬 El buzón volvió a funcionar." \
                     || anotar "📬 El buzón no está corriendo."
fi

# ---------- entrega (con reintento si no hay internet) ----------
[ -s "$PEND" ] || exit 0
if [ "$(wc -l < "$PEND")" -gt "$MAX_PEND" ]; then tail -n "$MAX_PEND" "$PEND" > "$PEND.tmp" && mv "$PEND.tmp" "$PEND"; fi
TEXTO=$(printf '🖥️ Mac 2015\n'; cat "$PEND")

if [ "$PROBAR" = 1 ]; then echo "--- (probar: no se envía) ---"; echo "$TEXTO"; exit 0; fi

if [ ! -f "$REPO/.env" ]; then echo "$(ahora) falta $REPO/.env: no puedo avisar"; exit 1; fi
set -a; . "$REPO/.env"; set +a
[ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ] || { echo "$(ahora) faltan las variables de Telegram"; exit 1; }

# El token viaja por stdin (curl -K -) para que no aparezca en la lista de procesos.
RESP=$(printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$TELEGRAM_BOT_TOKEN" \
  | curl -sS --max-time 20 -K - --data-urlencode "chat_id=$TELEGRAM_CHAT_ID" --data-urlencode "text=$TEXTO" 2>&1)
case "$RESP" in
  *'"ok":true'*) : > "$PEND"; echo "$(ahora) aviso enviado ($(echo "$TEXTO" | wc -l | tr -d ' ') líneas)" ;;
  *)             echo "$(ahora) no salió (sin internet?); queda pendiente. Respuesta: $(echo "$RESP" | cut -c1-120)" ;;
esac
