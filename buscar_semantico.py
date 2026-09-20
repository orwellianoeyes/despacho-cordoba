#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Búsqueda semántica sobre el índice de normas ya archivadas.

Qué resuelve: hoy para encontrar "todo lo que salió sobre obra pública en el
interior" hay que abrir los JSON día por día, o buscar por palabra exacta y
perder todo lo que use otra palabra. Esto pregunta por significado.

Cómo funciona: NO es una extensión de Postgres. Supabase no permite instalar
extensiones propias, así que el filtro corre acá, del lado de la aplicación:
se leen las filas y se le pregunta a Jev por cada una. El resultado es el
mismo que un WHERE semántico; el lugar donde se ejecuta es distinto.

El truco de costo: el `state` se paga una vez por request y las preguntas
extra casi no suman. Entonces en vez de una llamada por norma, van 20 normas
en un request con 20 preguntas — una por norma. Sale ~12x más barato que
preguntar de a una.

Requiere TYPESAFE_API_KEY.

Uso:
  python buscar_semantico.py "obra pública en el interior de la provincia"
  python buscar_semantico.py "algo que afecte a los municipios" --umbral 0.8
  python buscar_semantico.py "designaciones de funcionarios" --desde 2026-09-01
"""

import argparse
import glob
import json
import os
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

RAIZ = Path(__file__).resolve().parent
ENDPOINT = "https://api.typesafe.ai/v1/systemone"
MODELO = "jev-latest"
PRECIO_USD_POR_MILLON = 0.042
POR_LOTE = 20          # normas por request
HILOS = 6

API_KEY = os.environ.get("TYPESAFE_API_KEY", "").strip()


def cargar_normas(desde: str | None, hasta: str | None) -> list[dict]:
    """Junta el índice de todos los días archivados."""
    filas = []
    for ruta in sorted(glob.glob(str(RAIZ / "docs/data/2026-*.json"))):
        fecha = Path(ruta).stem
        if desde and fecha < desde:
            continue
        if hasta and fecha > hasta:
            continue
        try:
            d = json.loads(Path(ruta).read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        # El índice trae el título; `normas` trae además el "importa", que es
        # mejor material para juzgar. Se prefiere ese cuando existe.
        detalle = {(n.get("tipo"), n.get("numero")): n for n in d.get("normas", [])}
        for n in d.get("indice_nuevas", []):
            extra = detalle.get((n.get("tipo"), n.get("numero")), {})
            filas.append({
                "fecha": d.get("fecha", fecha),
                "boletin": d.get("numero_boletin", ""),
                "tipo": n.get("tipo", ""),
                "numero": n.get("numero", ""),
                "titulo": n.get("titulo", ""),
                "importa": extra.get("importa", ""),
                "seccion": n.get("seccion", ""),
                "pagina": n.get("pagina", ""),
            })
    return filas


def _consultar_lote(args) -> list[tuple[int, float]]:
    """Un request con POR_LOTE normas en el state y una pregunta por norma."""
    lote, criterio = args
    estado = {
        "criterion": criterio,
        "records": [
            {
                "id": f"r{i}",
                "type": f["tipo"],
                "number": f["numero"],
                "title": f["titulo"],
                "summary": f["importa"],
            }
            for i, f in enumerate(lote)
        ],
    }
    preguntas = {
        f"r{i}": {
            "type": "noul",
            "instructions": (
                f"Look at the record with id \"r{i}\" inside `records`. Judging "
                f"only from its title and summary, does that record match this "
                f"criterion, written in Spanish: \"{criterio}\"? Answer yes only "
                f"when the record's own subject matter matches. Ignore the other "
                f"records in the list."
            ),
        }
        for i in range(len(lote))
    }

    cuerpo = json.dumps(
        {"model": MODELO, "state": estado, "questions": preguntas},
        ensure_ascii=False,
    ).encode("utf-8")
    req = urllib.request.Request(
        ENDPOINT, data=cuerpo,
        headers={"Authorization": f"Bearer {API_KEY}",
                 "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.loads(r.read())
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
        print(f"  ⚠️  lote fallado: {str(e)[:60]}", file=sys.stderr)
        return []
    return [
        (i, data["answers"][f"r{i}"]["noul"], data["usage"]["input_tokens"])
        for i in range(len(lote))
    ]


def main():
    ap = argparse.ArgumentParser(description="Búsqueda semántica sobre las normas archivadas.")
    ap.add_argument("criterio", help="qué buscás, en castellano")
    ap.add_argument("--umbral", type=float, default=0.7, help="probabilidad mínima (0-1)")
    ap.add_argument("--desde", help="fecha AAAA-MM-DD")
    ap.add_argument("--hasta", help="fecha AAAA-MM-DD")
    ap.add_argument("--tope", type=int, default=30, help="cuántos resultados mostrar")
    a = ap.parse_args()

    if not API_KEY:
        print("❌ Falta TYPESAFE_API_KEY en el entorno.")
        return 1

    filas = cargar_normas(a.desde, a.hasta)
    if not filas:
        print("No hay normas archivadas en ese rango.")
        return 1

    lotes = [filas[i:i + POR_LOTE] for i in range(0, len(filas), POR_LOTE)]
    print(f"Buscando «{a.criterio}» en {len(filas)} normas ({len(lotes)} requests)…\n")

    with ThreadPoolExecutor(max_workers=HILOS) as pool:
        resultados = list(pool.map(_consultar_lote, [(l, a.criterio) for l in lotes]))

    puntuadas, tokens = [], 0
    for lote, res in zip(lotes, resultados):
        for i, prob, tok in res:
            puntuadas.append((prob, lote[i]))
        if res:
            tokens += res[0][2]

    coinciden = sorted([p for p in puntuadas if p[0] >= a.umbral],
                       key=lambda x: -x[0])

    print(f"{len(coinciden)} de {len(filas)} normas superan {a.umbral}\n")
    print(f"{'prob':>6}  {'fecha':<11} {'tipo':<14} {'nro':<7} título")
    print("─" * 100)
    for prob, f in coinciden[:a.tope]:
        print(f"{prob:>6.2f}  {f['fecha']:<11} {f['tipo'][:13]:<14} {f['numero'][:6]:<7} "
              f"{f['titulo'][:58]}")
    if len(coinciden) > a.tope:
        print(f"… y {len(coinciden) - a.tope} más (subí --tope)")

    costo = tokens / 1_000_000 * PRECIO_USD_POR_MILLON
    por_norma = costo / len(filas) if filas else 0
    print(f"\n{tokens:,} tokens · USD {costo:.5f} · USD {por_norma:.7f} por norma evaluada")
    return 0


if __name__ == "__main__":
    sys.exit(main())
