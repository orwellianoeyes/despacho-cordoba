#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Capa de datos: único punto de acceso a Supabase.

La usan el motor (boletin.py), el importador (migrar_a_supabase.py) y el
lector del buzón (buzon.py). Los archivos de docs/data/ y texto/ siguen
existiendo como respaldo en git; la base es lo que lee el panel.

Usa la service_role: saltea RLS. Es la credencial del motor, nunca la del
panel ni la del navegador.

Entorno:
    SUPABASE_URL          https://<ref>.supabase.co
    SUPABASE_SERVICE_KEY  Dashboard -> Settings -> API Keys -> Secret keys
"""

import datetime as dt
import json
import os
import re
import unicodedata

import requests

TOPE_LOTE = 2_000_000   # bytes de JSON por request: una página puede pesar 40 KB


def _cfg():
    return (os.environ.get("SUPABASE_URL", "").rstrip("/"),
            os.environ.get("SUPABASE_SERVICE_KEY", ""))


def disponible() -> bool:
    """¿Están las credenciales? Si no, el motor sigue igual con archivos."""
    url, key = _cfg()
    return bool(url and key)


def _sb(metodo: str, path: str, prefer: str | None = None, **kw):
    url, key = _cfg()
    if not url or not key:
        raise RuntimeError(
            "Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en el entorno.")
    cab = {"apikey": key, "Authorization": f"Bearer {key}",
           "Content-Type": "application/json"}
    if prefer:
        cab["Prefer"] = prefer
    r = requests.request(metodo, f"{url}/rest/v1/{path}",
                         headers=cab, timeout=120, **kw)
    if not r.ok:
        raise RuntimeError(f"Supabase {metodo} {path}: {r.status_code} {r.text[:300]}")
    return r.json() if r.text else []


def upsert(tabla: str, filas: list[dict], conflicto: str) -> int:
    """Sube en lotes acotados por peso. Devuelve cuántas filas mandó.

    PostgREST exige que TODAS las filas del lote tengan exactamente las
    mismas claves ("All object keys must match"): normalizalas antes."""
    if not filas:
        return 0
    enviadas, lote, peso = 0, [], 0
    for fila in filas:
        crudo = len(json.dumps(fila, ensure_ascii=False, default=str).encode())
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
# distintas: `normas` (destacadas, con análisis) e `indice_nuevas` (todas,
# solo metadatos). Medido sobre 33 días: solo el 18% coincide palabra por
# palabra. Emparejando además por el número —los dígitos sueltos, ignorando
# "N°", "Letra:D" y demás— la cobertura sube al 95%. El resto son destacadas
# que la IA no indexó: van como fila propia.

def pagina_entera(valor) -> int:
    """Igual que en boletin.py. Va también acá porque migrar_a_supabase.py
    lee archivos viejos, escritos antes de que el motor saneara esto."""
    if isinstance(valor, int):
        return valor if valor > 0 else 1
    m = re.search(r"\d+", str(valor or ""))
    return int(m.group(0)) if m else 1


def _sin_tildes(s: str) -> str:
    s = unicodedata.normalize("NFD", (s or "").lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", "", s)


def _digitos(s: str) -> str:
    m = re.findall(r"\d+", s or "")
    return m[0] if m else ""


def _emparejar(destacada: dict, indice: list[dict]) -> dict | None:
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


BASE_PDF = "https://boletinoficial.cba.gov.ar/wp-content/4p96humuzp"


def url_del_pdf(fecha: str, seccion: str) -> str:
    """El PDF de una sección se deduce de la fecha: no hay que arrastrar el
    link de ningún lado, se calcula.

    Se arrastraba, y por eso 1167 de 1222 normas quedaron sin link: al
    fusionar una destacada con su fila del índice se copiaban el análisis y
    la página, pero no el link, así que quedaba el vacío del índice."""
    a, m, d = fecha.split("-")
    return f"{BASE_PDF}/{a}/{m}/{seccion}_Secc_{d}{m}{a[2:]}.pdf"


COLUMNAS_NORMA = ("fecha", "tipo", "clase", "numero", "titulo", "seccion",
                  "pagina", "url_oficial", "destacada", "importa", "ampliada",
                  "texto_oficial", "analizada_por")


def armar_normas(despacho: dict, fecha: str) -> list[dict]:
    """Una fila por norma real: las del índice, marcando como destacadas las
    que el despacho analizó y pegándoles su análisis."""
    indice = despacho.get("indice_nuevas", []) or []
    filas, usadas = {}, set()
    clave = lambda e: (e.get("tipo", ""), e.get("numero", ""), e.get("titulo", ""))

    for e in indice:
        filas[clave(e)] = {
            "fecha": fecha, "tipo": e.get("tipo", "") or "",
            "numero": e.get("numero", "") or "", "titulo": e.get("titulo", "") or "",
            "seccion": str(e.get("seccion", "1")), "pagina": pagina_entera(e.get("pagina")),
            "url_oficial": url_del_pdf(fecha, str(e.get("seccion", "1"))),
            "destacada": False,
        }

    for n in despacho.get("normas", []) or []:
        par = _emparejar(n, indice)
        k = clave(par) if par and clave(par) not in usadas else clave(n)
        if par:
            usadas.add(clave(par))
        fila = filas.get(k) or {
            "fecha": fecha, "tipo": n.get("tipo", "") or "",
            "numero": n.get("numero", "") or "", "titulo": n.get("titulo", "") or "",
            "seccion": str(n.get("seccion", "1")), "pagina": pagina_entera(n.get("pagina")),
            "url_oficial": url_del_pdf(fecha, str(n.get("seccion", "1"))),
        }
        fila.update({
            "destacada": True, "clase": n.get("clase"), "importa": n.get("importa"),
            "ampliada": n.get("ampliada"), "texto_oficial": n.get("texto_oficial"),
            # El modelo exacto, no la familia. El panel ya guarda
            # "claude-sonnet-5" acá; el motor guardaba "claude" a secas hasta
            # el 22/09/2026. Los despachos viejos se quedan con la familia:
            # eso no se reconstruye hacia atrás.
            "analizada_por": despacho.get("modelo")
                             or despacho.get("motor", "claude"),
            "pagina": pagina_entera(n.get("pagina") or fila.get("pagina")),
        })
        filas[k] = fila

    return [{c: f.get(c) for c in COLUMNAS_NORMA} for f in filas.values()]


def armar_movimientos(despacho: dict, fecha: str) -> list[dict]:
    return [{
        "fecha": fecha, "tipo": m.get("tipo", "") or "", "clase": m.get("clase"),
        "instrumento": m.get("instrumento", "") or "",
        "titulo": m.get("titulo", "") or "", "detalle": m.get("detalle"),
        "organismo": m.get("organismo"), "pagina": pagina_entera(m.get("pagina")),
        "url_oficial": url_del_pdf(fecha, "1"),
    } for m in despacho.get("movimientos", []) or []]


def armar_paginas(texto: dict, fecha: str) -> list[dict]:
    return [{"fecha": fecha, "seccion": s, "pagina": i, "texto": txt,
             "url": v.get("url", "")}
            for s, v in (texto.get("secciones") or {}).items()
            for i, txt in enumerate(v.get("paginas", []), start=1)]


# ------------------------------- Escritura -------------------------------

def _limpiar_dia(fecha: str) -> None:
    """Borra lo que ese día había dejado, antes de reindexarlo.

    Sin esto, regenerar una edición deja conviviendo las dos tandas: el
    upsert va contra (fecha, tipo, numero, titulo), y si el motor nuevo
    escribe los títulos distinto —pasa siempre— las filas viejas quedan
    huérfanas. Es el mismo saneo que hace guardar() con indice.json.

    Se preservan las normas con análisis extenso: eso lo pidió alguien a
    mano y se pagó aparte. El resumen corto sí se rehace, porque justamente
    de eso se trata regenerar el día."""
    _sb("DELETE", f"normas?fecha=eq.{fecha}&extenso=is.null", prefer="return=minimal")
    _sb("DELETE", f"movimientos?fecha=eq.{fecha}", prefer="return=minimal")


def subir_despacho(despacho: dict, fecha: str) -> dict:
    """Despacho + normas + movimientos. Devuelve cuántas filas de cada cosa."""
    _limpiar_dia(fecha)
    n = upsert("despachos", [{
        "fecha": fecha,
        "numero_boletin": despacho.get("numero_boletin", "s/d") or "s/d",
        "secciones": sorted({str(x.get("seccion", "1"))
                             for x in despacho.get("normas", [])} or {"1"}),
        "motor": despacho.get("motor", "claude"),
        "sintesis_juridica": despacho.get("sintesis_juridica", []),
        "sintesis_politica": despacho.get("sintesis_politica", []),
        "telegram": despacho.get("telegram"),
        "hora_procesado": despacho.get("hora_procesado"),
    }], "fecha")
    return {
        "despacho": n,
        "normas": upsert("normas", armar_normas(despacho, fecha),
                         "fecha,tipo,numero,titulo"),
        "movimientos": upsert("movimientos", armar_movimientos(despacho, fecha),
                              "fecha,tipo,instrumento,titulo"),
    }


def subir_paginas(texto: dict, fecha: str) -> int:
    return upsert("paginas", armar_paginas(texto, fecha), "fecha,seccion,pagina")


# -------------------------------- El buzón --------------------------------
# El panel vive en la nube y la Mac baja los PDF (el Boletín responde 403 a
# las IP de datacenter). La nube no puede darle órdenes a la Mac, así que se
# da vuelta: el panel deja el pedido acá y la Mac lo levanta. La Mac nunca
# queda expuesta a internet.

def _ahora() -> str:
    """Timestamp ISO en UTC. PostgREST manda el valor como texto y Postgres
    NO acepta la cadena 'now()' para un timestamptz: hay que darle una fecha
    de verdad."""
    return dt.datetime.now(dt.timezone.utc).isoformat()


def corrida_pendiente() -> dict | None:
    filas = _sb("GET", "corridas?estado=eq.pendiente&order=pedida_en.asc&limit=1")
    return filas[0] if filas else None


def tomar_corrida(id_: int) -> bool:
    """Marca la corrida como tomada. Devuelve False si otro la agarró primero:
    el filtro por estado hace que sea atómico."""
    filas = _sb("PATCH", f"corridas?id=eq.{id_}&estado=eq.pendiente",
                prefer="return=representation",
                json={"estado": "tomada", "tomada_en": _ahora()})
    return bool(filas)


def terminar_corrida(id_: int, estado: str, detalle: str | None = None) -> None:
    _sb("PATCH", f"corridas?id=eq.{id_}", prefer="return=minimal",
        json={"estado": estado, "detalle": detalle, "terminada_en": _ahora()})
