#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Sube a Supabase lo que vive en archivos: los despachos de docs/data/ y el
texto crudo de texto/.

Desde la Etapa 2.5 el motor sube solo al terminar cada corrida, así que
esto quedó para tres casos: la carga inicial, rellenar días viejos, y
recuperar una subida que falló mientras la base no contestaba.

Es idempotente (upsert contra claves naturales): correrlo de nuevo
actualiza, no duplica.

    python migrar_a_supabase.py
    python migrar_a_supabase.py --fecha 2026-09-16
    python migrar_a_supabase.py --seco     # qué haría, sin escribir
"""

import argparse
import json
import sys
from pathlib import Path

import datos

RAIZ = Path(__file__).resolve().parent
DATA = RAIZ / "docs" / "data"
TEXTO = RAIZ / "texto"


def subir_dia(fecha: str, seco: bool) -> dict:
    c = {"despacho": 0, "normas": 0, "movimientos": 0, "paginas": 0}

    ruta = DATA / f"{fecha}.json"
    if ruta.exists():
        d = json.loads(ruta.read_text(encoding="utf-8"))
        if seco:
            c["despacho"] = 1
            c["normas"] = len(datos.armar_normas(d, fecha))
            c["movimientos"] = len(datos.armar_movimientos(d, fecha))
        else:
            c.update(datos.subir_despacho(d, fecha))

    rt = TEXTO / f"{fecha}.json"
    if rt.exists():
        t = json.loads(rt.read_text(encoding="utf-8"))
        c["paginas"] = (len(datos.armar_paginas(t, fecha)) if seco
                        else datos.subir_paginas(t, fecha))
    return c


def main():
    ap = argparse.ArgumentParser(description="Sube los archivos del repo a Supabase.")
    ap.add_argument("--fecha", metavar="AAAA-MM-DD", help="Solo esa edición.")
    ap.add_argument("--seco", action="store_true",
                    help="Muestra qué subiría, sin escribir nada.")
    args = ap.parse_args()

    if not args.seco and not datos.disponible():
        raise SystemExit("Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en el entorno.")

    fechas = ([args.fecha] if args.fecha else
              sorted({p.stem for p in DATA.glob("2026-*.json")} |
                     {p.stem for p in TEXTO.glob("2026-*.json")}))
    if not fechas:
        raise SystemExit("No encontré días para subir.")

    print(("— PRUEBA EN SECO — " if args.seco else "— Subiendo a Supabase — ")
          + f"{len(fechas)} días\n")
    tot = {"despacho": 0, "normas": 0, "movimientos": 0, "paginas": 0}
    for f in fechas:
        c = subir_dia(f, args.seco)
        for k in tot:
            tot[k] += c[k]
        print(f"  {f}  despacho {c['despacho']} · normas {c['normas']:>3} · "
              f"movimientos {c['movimientos']:>2} · páginas {c['paginas']:>3}")

    print(f"\nTotal: {tot['despacho']} despachos · {tot['normas']} normas · "
          f"{tot['movimientos']} movimientos · {tot['paginas']} páginas")
    if args.seco:
        print("Nada se escribió (--seco).")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"❌ {e}")
        sys.exit(1)
