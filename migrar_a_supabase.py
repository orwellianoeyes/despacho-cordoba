#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Sube a Supabase lo que hoy vive en archivos: los despachos de docs/data/
y el texto crudo de texto/.

Es idempotente: se puede correr todas las veces que haga falta. Usa upsert
contra las claves naturales, así que volver a subir un día lo actualiza en
vez de duplicarlo.

    python migrar_a_supabase.py            # sube todo
    python migrar_a_supabase.py --fecha 2026-09-16
    python migrar_a_supabase.py --seco     # muestra qué haría, sin escribir

Necesita en el entorno (van en .env):
    SUPABASE_URL          https://<ref>.supabase.co
    SUPABASE_SERVICE_KEY  Dashboard -> Settings -> API -> service_role
                          Saltea RLS: es la credencial del motor, NUNCA
                          la del panel ni la del repo.
"""

import argparse
import json
import os
import re
import sys
import unicodedata
from pathlib import Path

import requests

RAIZ = Path(__file__).resolve().parent
DATA = RAIZ / "docs" / "data"
TEXTO = RAIZ / "texto"

URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
CAB = {"apikey": KEY, "Authorization": f"Bearer {KEY}",
       "Content-Type": "application/json"}

# Los textos de página pueden ser de 40 mil caracteres; conviene cortar por
# tamaño y no por cantidad de filas.
TOPE_LOTE = 2_000_000   # bytes de JSON por request


def _sb(metodo: str, path: str, prefer: str | None = None, **kw):
    if not URL or not KEY:
        raise SystemExit(
            "Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en el entorno.\n"
            "La service_role está en el Dashboard -> Settings -> API.")
    cab = dict(CAB)
    if prefer:
        cab["Prefer"] = prefer
    r = requests.request(metodo, f"{URL}/rest/v1/{path}", headers=cab, timeout=120, **kw)
    if not r.ok:
        raise RuntimeError(f"Supabase {metodo} {path}: {r.status_code} {r.text[:400]}")
    return r.json() if r.text else []


def _upsert(tabla: str, filas: list[dict], conflicto: str, seco: bool):
    """Sube en lotes acotados por peso. Devuelve cuántas filas mandó."""
    if not filas:
        return 0
    if seco:
        return len(filas)
    enviadas, lote, peso = 0, [], 0
    for fila in filas:
        crudo = len(json.dumps(fila, ensure_ascii=False).encode())
        if lote and peso + crudo > TOPE_LOTE:
            _sb("POST", f"{tabla}?on_conflict={conflicto}",
                prefer="resolution=merge-duplicates,return=minimal", json=lote)
            enviadas += len(lote); lote, peso = [], 0
        lote.append(fila); peso += crudo
    if lote:
        _sb("POST", f"{tabla}?on_conflict={conflicto}",
            prefer="resolution=merge-duplicates,return=minimal", json=lote)
        enviadas += len(lote)
    return enviadas


# --------------------------- Emparejar normas ---------------------------
# El JSON trae dos listas que hablan de las mismas normas con identidades
# distintas: `normas` (las destacadas, con análisis) e `indice_nuevas`
# (todas, solo metadatos). Medido sobre los 33 días: solo el 18% coincide
# palabra por palabra. Emparejando además por el número —los dígitos
# sueltos, ignorando "N°", "Letra:D" y demás— la cobertura sube al 95%.
# El 5% que queda son destacadas que la IA no indexó: van como fila propia.

def _sin_tildes(s: str) -> str:
    s = unicodedata.normalize("NFD", (s or "").lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", "", s)


def _digitos(s: str) -> str:
    m = re.findall(r"\d+", s or "")
    return m[0] if m else ""


def _emparejar(destacada: dict, indice: list[dict]) -> dict | None:
    """Fila del índice que corresponde a esta destacada, o None."""
    clave = (destacada.get("tipo", ""), destacada.get("numero", ""),
             destacada.get("titulo", ""))
    for e in indice:
        if (e.get("tipo", ""), e.get("numero", ""), e.get("titulo", "")) == clave:
            return e

    # Por número, solo si es inequívoco: una edición puede traer varias
    # entradas con el mismo dígito y ahí adivinar sería peor que no unir.
    num = _digitos(destacada.get("numero", ""))
    if num:
        cands = [e for e in indice if _digitos(e.get("numero", "")) == num]
        if len(cands) == 1:
            return cands[0]

    tit = _sin_tildes(destacada.get("titulo", ""))
    if tit:
        cands = [e for e in indice if _sin_tildes(e.get("titulo", "")) == tit]
        if len(cands) == 1:
            return cands[0]
    return None


def armar_normas(despacho: dict, fecha: str) -> list[dict]:
    """Una fila por norma real: las del índice, marcando como destacadas
    las que el despacho analizó y pegándoles su análisis."""
    indice = despacho.get("indice_nuevas", []) or []
    filas, usadas = {}, set()

    def clave(e):
        return (e.get("tipo", ""), e.get("numero", ""), e.get("titulo", ""))

    for e in indice:
        filas[clave(e)] = {
            "fecha": fecha, "tipo": e.get("tipo", "") or "",
            "numero": e.get("numero", "") or "", "titulo": e.get("titulo", "") or "",
            "seccion": str(e.get("seccion", "1")), "pagina": e.get("pagina", 1) or 1,
            "url_oficial": e.get("url", ""), "destacada": False,
        }

    for n in despacho.get("normas", []) or []:
        par = _emparejar(n, indice)
        k = clave(par) if par and clave(par) not in usadas else clave(n)
        if par:
            usadas.add(clave(par))
        fila = filas.get(k) or {
            "fecha": fecha, "tipo": n.get("tipo", "") or "",
            "numero": n.get("numero", "") or "", "titulo": n.get("titulo", "") or "",
            "seccion": str(n.get("seccion", "1")), "pagina": n.get("pagina", 1) or 1,
            "url_oficial": n.get("url_oficial", ""),
        }
        fila.update({
            "destacada": True,
            "clase": n.get("clase"),
            "importa": n.get("importa"),
            "ampliada": n.get("ampliada"),
            "texto_oficial": n.get("texto_oficial"),
            "analizada_por": despacho.get("motor", "claude"),
            "pagina": n.get("pagina") or fila.get("pagina", 1),
        })
        filas[k] = fila

    return list(filas.values())


# ------------------------------- Subida --------------------------------

def subir_dia(fecha: str, seco: bool) -> dict:
    cuenta = {"despacho": 0, "normas": 0, "movimientos": 0, "paginas": 0}

    ruta = DATA / f"{fecha}.json"
    if ruta.exists():
        d = json.loads(ruta.read_text(encoding="utf-8"))
        cuenta["despacho"] = _upsert("despachos", [{
            "fecha": fecha,
            "numero_boletin": d.get("numero_boletin", "s/d") or "s/d",
            "secciones": sorted({str(n.get("seccion", "1"))
                                 for n in d.get("normas", [])} or {"1"}),
            "motor": d.get("motor", "claude"),
            "sintesis_juridica": d.get("sintesis_juridica", []),
            "sintesis_politica": d.get("sintesis_politica", []),
            "telegram": d.get("telegram"),
            "hora_procesado": d.get("hora_procesado"),
        }], "fecha", seco)
        cuenta["normas"] = _upsert("normas", armar_normas(d, fecha),
                                   "fecha,tipo,numero,titulo", seco)
        cuenta["movimientos"] = _upsert("movimientos", [{
            "fecha": fecha, "tipo": m.get("tipo", "") or "",
            "clase": m.get("clase"),
            "instrumento": m.get("instrumento", "") or "",
            "titulo": m.get("titulo", "") or "",
            "detalle": m.get("detalle"), "organismo": m.get("organismo"),
            "pagina": m.get("pagina", 1) or 1,
            "url_oficial": m.get("url_oficial", ""),
        } for m in d.get("movimientos", []) or []],
            "fecha,tipo,instrumento,titulo", seco)

    rt = TEXTO / f"{fecha}.json"
    if rt.exists():
        t = json.loads(rt.read_text(encoding="utf-8"))
        paginas = [{"fecha": fecha, "seccion": s, "pagina": i,
                    "texto": txt, "url": v.get("url", "")}
                   for s, v in t.get("secciones", {}).items()
                   for i, txt in enumerate(v.get("paginas", []), start=1)]
        cuenta["paginas"] = _upsert("paginas", paginas, "fecha,seccion,pagina", seco)

    return cuenta


def main():
    ap = argparse.ArgumentParser(description="Sube los archivos del repo a Supabase.")
    ap.add_argument("--fecha", metavar="AAAA-MM-DD", help="Solo esa edición.")
    ap.add_argument("--seco", action="store_true",
                    help="Muestra qué subiría, sin escribir nada.")
    args = ap.parse_args()

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
