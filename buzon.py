#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Lector del buzón: la Mac le pregunta a Supabase si hay algo que hacer.

El panel vive en la nube y la descarga tiene que salir de una IP hogareña
(el Boletín responde 403 a las IP de datacenter). La nube no puede darle
una orden a la Mac, así que se da vuelta la dirección: el panel deja el
pedido en la tabla `corridas` y este proceso lo levanta. La Mac nunca
queda expuesta a internet — no abre ningún puerto, solo consulta.

    python buzon.py                 # escucha cada 60 segundos
    python buzon.py --intervalo 300 # cada 5 minutos
    python buzon.py --una-vez       # mira una vez y sale (para probar)

Necesita SUPABASE_URL y SUPABASE_SERVICE_KEY en el entorno: usá escuchar.sh,
que carga el .env antes.
"""

import argparse
import datetime as dt
import re
import subprocess
import sys
import time
from pathlib import Path

import datos

RAIZ = Path(__file__).resolve().parent
PYTHON = str(RAIZ / ".venv" / "bin" / "python")
TOPE_CORRIDA = 20 * 60          # segundos: una corrida larga con reintentos


def _ahora() -> str:
    return dt.datetime.now().strftime("%H:%M:%S")


def armar_comando(corrida: dict) -> list[str]:
    """Traduce una fila de `corridas` a argumentos de boletin.py.

    La fila viene de la base, o sea que es DATO, no una orden: se valida
    todo antes de armar el comando. Se pasa como lista y nunca por shell,
    así que tampoco hay forma de inyectar nada."""
    fecha = str(corrida.get("fecha", ""))
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", fecha):
        raise ValueError(f"fecha inválida: {fecha!r}")

    cmd = [PYTHON, str(RAIZ / "boletin.py"), "--fecha", fecha]

    secciones = corrida.get("secciones") or []
    if not all(isinstance(s, str) and re.fullmatch(r"[1-5]", s) for s in secciones):
        raise ValueError(f"secciones inválidas: {secciones!r}")
    if secciones:
        cmd += ["--secciones", ",".join(secciones)]

    if corrida.get("rehacer"):
        cmd.append("--rehacer")

    if corrida.get("sin_ia"):
        cmd.append("--sin-ia")
    else:
        motor = corrida.get("motor") or "claude"
        if motor not in ("claude", "gemini"):
            raise ValueError(f"motor inválido: {motor!r}")
        cmd += ["--motor", motor]

    return cmd


def ejecutar(corrida: dict) -> tuple[str, str]:
    """Corre el motor. Devuelve (estado, detalle) para dejar en la base."""
    try:
        cmd = armar_comando(corrida)
    except ValueError as e:
        return "fallida", f"pedido inválido: {e}"

    print(f"   {' '.join(cmd[1:])}")
    try:
        r = subprocess.run(cmd, cwd=RAIZ, capture_output=True, text=True,
                           timeout=TOPE_CORRIDA)
    except subprocess.TimeoutExpired:
        return "fallida", f"la corrida pasó de {TOPE_CORRIDA // 60} minutos"

    salida = (r.stdout or "") + (r.stderr or "")
    for linea in salida.splitlines():
        print(f"   │ {linea}")
    # Las últimas líneas son las que dicen qué pasó; el resto es ruido.
    cola = "\n".join(salida.strip().splitlines()[-6:])
    # 3 = el Boletín de esa fecha no está (ver SALIDA_SIN_EDICION en
    # boletin.py). Antes salía 0 y el panel decía "listo" sin haber hecho nada.
    if r.returncode == 3:
        return "sin_edicion", cola
    return ("lista" if r.returncode == 0 else "fallida"), cola


def una_vuelta() -> bool:
    """Atiende un pedido si lo hay. Devuelve True si hizo algo."""
    corrida = datos.corrida_pendiente()
    if not corrida:
        return False

    id_ = corrida["id"]
    if not datos.tomar_corrida(id_):
        # Otro proceso la agarró primero. El PATCH filtra por estado, así
        # que la carrera se resuelve sola y sin duplicar trabajo.
        print(f"[{_ahora()}] corrida {id_}: la tomó otro; sigo.")
        return True

    print(f"[{_ahora()}] corrida {id_} tomada · {corrida.get('fecha')}")
    estado, detalle = ejecutar(corrida)
    datos.terminar_corrida(id_, estado, detalle)
    print(f"[{_ahora()}] corrida {id_} → {estado}\n")
    return True


def main():
    ap = argparse.ArgumentParser(description="Escucha pedidos de corrida desde el panel.")
    ap.add_argument("--intervalo", type=int, default=60, metavar="SEG",
                    help="Cada cuánto preguntar. Por defecto 60 segundos.")
    ap.add_argument("--una-vez", action="store_true",
                    help="Mira una sola vez y sale.")
    args = ap.parse_args()

    if not datos.disponible():
        raise SystemExit("Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY. Usá escuchar.sh.")

    if args.una_vez:
        if not una_vuelta():
            print("Sin pedidos pendientes.")
        return

    print(f"Escuchando el buzón cada {args.intervalo} s. Ctrl+C para cortar.")
    while True:
        try:
            if not una_vuelta():
                time.sleep(args.intervalo)
        except KeyboardInterrupt:
            print("\nCortado.")
            return
        except Exception as e:
            # Un error de red no puede matar al que escucha: se reporta y
            # se sigue esperando. Si la base está caída, vuelve sola.
            print(f"[{_ahora()}] ⚠️  {type(e).__name__}: {e}")
            time.sleep(args.intervalo)


if __name__ == "__main__":
    main()
