#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DESPACHO DIARIO — Boletín Oficial de la Provincia de Córdoba
============================================================
Se dispara a mano (launchd quedó desactivado en septiembre de 2026).
Es idempotente: si el despacho de esa fecha ya existe, no hace nada; si
el boletín aún no se publicó, termina en silencio.

    python boletin.py                      → la edición de hoy
    python boletin.py --fecha 2026-09-08   → recuperar un día pasado
    python boletin.py --rehacer            → regenerar uno ya hecho

Flujo: descargar PDFs → extraer texto con marcadores de página →
archivar ese texto en texto/ → llamar a la API con instrucciones.md →
guardar JSON del día + actualizar índice → avisar por Telegram.

Variables de entorno (en GitHub van como Secrets):
  ANTHROPIC_API_KEY   (obligatoria)
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID          (opcionales)
  GMAIL_USUARIO, GMAIL_CLAVE_APP                (opcionales)
  APP_URL  → link de la app para incluir en los avisos (opcional)
"""

import argparse
import datetime as dt
import json
import os
import re
import smtplib
import sys
import time
from email.mime.text import MIMEText
from io import BytesIO
from pathlib import Path

import requests
from pypdf import PdfReader

import anthropic
# ----------------------------- Configuración -----------------------------

TZ_CORDOBA = dt.timezone(dt.timedelta(hours=-3))

# Fecha de la edición que se procesa. Por defecto hoy en Córdoba, pero
# --fecha permite recuperar un día pasado: los PDF del Boletín siguen
# publicados, así que un día que no se corrió no está perdido.
HOY = dt.datetime.now(TZ_CORDOBA).date()

RAIZ = Path(__file__).resolve().parent
DOCS = RAIZ / "docs"
DATA = DOCS / "data"
TEXTO = RAIZ / "texto"

# ---- Motor de IA (conmutable; --motor lo pisa por corrida) ----
# Claude va de primario a propósito: esto es análisis jurídico fino, no
# clasificación. Es donde la diferencia de calidad se nota y es lo que se
# ofrece al cliente. Gemini queda de respaldo para el caso que ya pasó una
# vez: quedarse sin crédito y no poder sacar el despacho del día.
MOTOR = "claude"
MOTOR_RESPALDO = "gemini"          # None para desactivar el respaldo

MODELO_CLAUDE = "claude-haiku-4-5"
# Pool: el free tier de Gemini tira 503 intermitentes y los alias *-latest a
# veces cuelgan, así que un fallo rápido pasa al siguiente modelo.
MODELOS_GEMINI = ["gemini-flash-lite-latest", "gemini-3.1-flash-lite"]
MAX_TOKENS_SALIDA = 32000
TIMEOUT_IA = 600

GEMINI_URL = ("https://generativelanguage.googleapis.com"
              "/v1beta/models/{modelo}:generateContent")

# 1ª Legislación · 2ª Judiciales · 3ª Sociedades · 4ª Licitaciones · 5ª Varios.
# Ninguna es obligatoria: se procesa lo que haya publicado ese día.
# --secciones lo pisa por corrida (ej.: --secciones 1,4,5).
SECCIONES = ["1", "4"]

# Tope práctico de entrada, en caracteres del boletín.
#
# La ventana de Claude son 200 mil tokens e incluye la respuesta, así que con
# MAX_TOKENS_SALIDA=32000 quedan ~168 mil para la entrada. A ~3,5 caracteres
# por token en español eso da ~588 mil caracteres; se deja margen.
#
# Medición real del 16/09/2026: secc. 1 = 4k · 2 = 484k · 3 = 331k · 4 = 100k
# · 5 = 67k caracteres. O sea que 1+3+4+5 entra, y lo único que revienta el
# tope es sumar la 2ª (Judiciales), que además es la de menos valor acá:
# 60 páginas de edictos y sucesiones. Si algún día hace falta, hay que
# partir el análisis en una llamada por sección y unir los resultados.
LIMITE_CARACTERES = 550_000

CABECERAS_NAVEGADOR = {
    "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/138.0.0.0 Safari/537.36"),
    "Accept": "text/html,application/xhtml+xml,application/pdf,*/*;q=0.8",
    "Accept-Language": "es-AR,es;q=0.9,en;q=0.8",
    "Referer": "https://boletinoficial.cba.gov.ar/",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Upgrade-Insecure-Requests": "1",
}
# ------------------------------- Descarga --------------------------------

# Patrón de URL de los PDF del Boletín, verificado contra ediciones reales:
#   https://boletinoficial.cba.gov.ar/wp-content/4p96humuzp/2026/07/1_Secc_070726.pdf
#                                                          └año┘└mes┘ │       └DDMMAA┘
#                                                                     └ número de sección
BASE_PDF = "https://boletinoficial.cba.gov.ar/wp-content/4p96humuzp"


def _url_pdf(fecha: dt.date, seccion: str) -> str:
    """Arma la URL del PDF de una sección para una fecha dada."""
    return (f"{BASE_PDF}/{fecha.year}/{fecha.month:02d}/"
            f"{seccion}_Secc_{fecha.strftime('%d%m%y')}.pdf")


def _bajar_pdf(url: str):
    """
    Devuelve los bytes del PDF, o None si todavía no está publicado.
    Distingue tres casos: no existe (404), existe pero no es un PDF real
    (el sitio a veces responde una página de error con código 200), y
    descarga correcta.
    """
    try:
        r = requests.get(url, headers=CABECERAS_NAVEGADOR, timeout=90)
    except requests.RequestException as e:
        print(f"   · error de red en {url}: {e}")
        return None

    if r.status_code in (403, 404):
        print(f"   · el servidor respondió {r.status_code}")
        return None
    r.raise_for_status()

    if not r.content.startswith(b"%PDF"):
        print(f"   · la respuesta de {url} no es un PDF (¿aún no publicado?)")
        return None

    return r.content


def descargar_pdfs(secciones: list[str]):
    """
    Descarga las secciones pedidas de la edición de HOY.

    Devuelve [(seccion, bytes_del_pdf, url), ...] o [] si el boletín
    todavía no salió (en ese caso el workflow reintenta más tarde).

    Ninguna sección es obligatoria: hay días en que se publica una y no
    otra (por ejemplo, solo licitaciones sin legislación nueva). Solo se
    considera "no publicado" cuando no apareció ninguna de las configuradas.
    """
    pdfs = []

    for seccion in secciones:
        url = _url_pdf(HOY, seccion)
        print(f"→ Sección {seccion}: {url}")
        contenido = _bajar_pdf(url)

        if contenido is None:
            # Ninguna sección es obligatoria: hay días sin 1ª Sección
            # (sin legislación nueva) pero con licitaciones o judiciales.
            print(f"   Sección {seccion} no está publicada hoy; se continúa sin ella.")
            continue

        print(f"   ✓ {len(contenido) // 1024} KB descargados")
        pdfs.append((seccion, contenido, url))

    if not pdfs:
        print("   Ninguna de las secciones pedidas está publicada todavía.")

    return pdfs

# --------------------------- Extracción de texto --------------------------

def extraer_paginas(pdf_bytes: bytes) -> list[str]:
    """Texto de cada página del PDF, en orden."""
    lector = PdfReader(BytesIO(pdf_bytes))
    return [(pagina.extract_text() or "").strip() for pagina in lector.pages]


def con_marcadores(paginas: list[str]) -> str:
    """Pega las páginas con marcadores '=== PÁGINA N ===' para que la IA
    pueda informar la página exacta de cada norma."""
    return "\n\n".join(f"=== PÁGINA {i} ===\n{txt}"
                       for i, txt in enumerate(paginas, start=1))


def detectar_numero_boletin(texto: str) -> str:
    # Cabecera real: "AÑO CXIII - TOMO DCCXXXIX - N° 140"
    m = re.search(r"TOMO[^\n]{0,40}?N[°ºo]\s*(\d{1,4})", texto)
    if m:
        return m.group(1)
    m = re.search(r"BOLET[ÍI]N\s+OFICIAL[^\n]{0,40}?N[°ºo]?\s*([\d\.]+)", texto, re.I)
    return m.group(1) if m else "s/d"

# ------------------------------ Llamado a la API ---------------------------

def _construir_prompt(texto_boletin: str) -> tuple[str, str]:
    """Devuelve (instrucciones, boletín). Van separados porque los dos
    motores toman las instrucciones como mensaje de sistema."""
    instrucciones = (RAIZ / "instrucciones.md").read_text(encoding="utf-8")
    return instrucciones, "=== BOLETÍN DE HOY ===\n\n" + texto_boletin


def _llamar_claude(sistema: str, usuario: str) -> str:
    cliente = anthropic.Anthropic(timeout=float(TIMEOUT_IA), max_retries=3)

    # Streaming: obligatorio cuando max_tokens es alto (el SDK lo exige si
    # estima que la respuesta puede tardar más de 10 minutos).
    with cliente.messages.stream(
        model=MODELO_CLAUDE,
        max_tokens=MAX_TOKENS_SALIDA,
        system=sistema,
        messages=[{"role": "user", "content": usuario}],
    ) as flujo:
        respuesta = flujo.get_final_message()

    if getattr(respuesta, "stop_reason", "") == "max_tokens":
        raise RuntimeError("La respuesta de la IA quedó truncada: subir MAX_TOKENS_SALIDA.")
    return "".join(b.text for b in respuesta.content if b.type == "text")


def _gemini_una_vez(sistema: str, usuario: str, modelo: str, clave: str) -> str:
    cuerpo = {
        "system_instruction": {"parts": [{"text": sistema}]},
        "contents": [{"role": "user", "parts": [{"text": usuario}]}],
        "generationConfig": {
            "temperature": 0.2,
            "responseMimeType": "application/json",   # fuerza JSON, sin ```
            "maxOutputTokens": MAX_TOKENS_SALIDA,
        },
        # El boletín trae contenido político y penal; sin esto Gemini a veces
        # bloquea la respuesta entera. Se permite todo salvo lo grave.
        "safetySettings": [
            {"category": c, "threshold": "BLOCK_ONLY_HIGH"} for c in (
                "HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH",
                "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT")
        ],
    }
    r = requests.post(GEMINI_URL.format(modelo=modelo), params={"key": clave},
                      json=cuerpo, timeout=TIMEOUT_IA)
    r.raise_for_status()
    datos = r.json()
    try:
        return datos["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError):
        raise RuntimeError(f"respuesta inesperada de {modelo}: {str(datos)[:200]}")


def _llamar_gemini(sistema: str, usuario: str) -> str:
    clave = os.environ.get("GEMINI_API_KEY")
    if not clave:
        raise RuntimeError("Falta GEMINI_API_KEY en el entorno.")
    ultimo = None
    for modelo in MODELOS_GEMINI:
        try:
            return _gemini_una_vez(sistema, usuario, modelo, clave)
        except Exception as e:
            ultimo = f"{modelo}: {type(e).__name__}"
            print(f"      · gemini/{modelo} falló ({type(e).__name__}); sigo.")
    raise RuntimeError(f"pool de Gemini agotado (último: {ultimo}).")


def _invocar(motor: str, sistema: str, usuario: str) -> str:
    """Una llamada a un motor, cronometrada.

    El cronómetro no es decorativo: una de cada tres corridas venía fallando
    con "read operation timed out" y sin saber cuánto había tardado no se
    puede distinguir un corte de red (falla a los pocos segundos) de un
    timeout real del cliente (falla a los 600). El dato va al log siempre."""
    comienzo = time.monotonic()
    try:
        if motor == "claude":
            bruto = _llamar_claude(sistema, usuario)
        elif motor == "gemini":
            bruto = _llamar_gemini(sistema, usuario)
        else:
            raise RuntimeError(f"Motor desconocido: {motor!r}")
    except Exception as e:
        print(f"   · {motor} cortó a los {time.monotonic() - comienzo:.0f} s "
              f"({type(e).__name__})")
        raise
    print(f"   · {motor} respondió en {time.monotonic() - comienzo:.0f} s")
    return bruto


def llamar_api(texto_boletin: str, motor: str) -> tuple[dict, str]:
    """Genera el despacho. Devuelve (despacho, motor que lo escribió).

    Si el primario falla —sin crédito, caída del proveedor— se intenta con
    el respaldo. Qué motor salió queda guardado y se avisa: un respaldo
    silencioso es peor que no tener respaldo, porque la calidad baja sin
    que nadie se entere."""
    sistema, usuario = _construir_prompt(texto_boletin)

    intentos = [motor]
    if MOTOR_RESPALDO and MOTOR_RESPALDO != motor:
        intentos.append(MOTOR_RESPALDO)

    bruto, usado, ultimo_error = None, None, None
    for candidato in intentos:
        try:
            print(f"   · consultando {candidato}…")
            bruto, usado = _invocar(candidato, sistema, usuario), candidato
            break
        except Exception as e:
            ultimo_error = e
            print(f"   ⚠️  {candidato} falló: {e}")
            if candidato != intentos[-1]:
                print("       pruebo con el respaldo…")
    if bruto is None:
        raise RuntimeError(f"Fallaron todos los motores. Último: {ultimo_error}")

    bruto = re.sub(r"^```(?:json)?\s*|\s*```$", "", bruto.strip())
    try:
        return json.loads(bruto), usado
    except json.JSONDecodeError:
        # Guardar la salida cruda para diagnóstico y abortar con error real.
        (RAIZ / f"salida_invalida_{HOY}_{usado}.txt").write_text(bruto, encoding="utf-8")
        raise


def sanear_valores(v):
    """Neutraliza cualquier HTML que pudiera venir en los textos generados
    (defensa ante inyecciones en el documento fuente)."""
    if isinstance(v, str):
        return v.replace("<", "\u2039").replace(">", "\u203a")
    if isinstance(v, list):
        return [sanear_valores(x) for x in v]
    if isinstance(v, dict):
        return {k: sanear_valores(x) for k, x in v.items()}
    return v

# ------------------------------- Persistencia -----------------------------

def _url_de_seccion(etiqueta_seccion: str, urls: dict) -> str:
    """'1ª Sección · Legislación' → urls['1'] (o la primera disponible)."""
    m = re.search(r"[1-5]", etiqueta_seccion or "")
    if m and m.group(0) in urls:
        return urls[m.group(0)]
    print(f"   ⚠️  Seccion no resuelta para {etiqueta_seccion!r}; usa Seccion 1.")
    return urls.get("1") or next(iter(urls.values()), "https://boletinoficial.cba.gov.ar/")


def guardar(despacho: dict, urls: dict) -> None:
    despacho = sanear_valores(despacho)
    DATA.mkdir(parents=True, exist_ok=True)
    ahora = dt.datetime.now(TZ_CORDOBA).strftime("%H:%M")

    despacho["fecha"] = str(HOY)
    despacho["hora_procesado"] = ahora
    despacho["estado"] = "publicado"

    # Completar URL oficial en normas y movimientos según su sección
    for n in despacho.get("normas", []):
        n.setdefault("pagina", 1)
        n["url_oficial"] = _url_de_seccion(n.get("seccion", "1"), urls)
    for m in despacho.get("movimientos", []):
        m.setdefault("pagina", 1)
        m["url_oficial"] = _url_de_seccion("1", urls)

    # 1) Despacho del día
    (DATA / f"{HOY}.json").write_text(
        json.dumps(despacho, ensure_ascii=False, indent=1), encoding="utf-8"
    )

    # 2) Índice acumulado (solo metadatos, para el buscador)
    ruta_indice = DATA / "indice.json"
    indice = json.loads(ruta_indice.read_text(encoding="utf-8")) if ruta_indice.exists() else []
    existentes = {(e.get("fecha"), e.get("numero")) for e in indice}
    nro = despacho.get("numero_boletin", "s/d")

    nuevos = []
    for e in despacho.get("indice_nuevas", []):
        nuevos.append({
            "fecha": str(HOY), "boletin": nro,
            "tipo": e.get("tipo", ""), "numero": e.get("numero", ""),
            "titulo": e.get("titulo", ""), "pagina": e.get("pagina", 1),
            "url": _url_de_seccion(e.get("seccion", "1"), urls),
        })
    for m in despacho.get("movimientos", []):
        nuevos.append({
            "fecha": str(HOY), "boletin": nro,
            "tipo": m.get("tipo", "Designación"), "numero": m.get("instrumento", ""),
            "titulo": f"{m.get('titulo', '')} — {m.get('organismo', '')}".strip(" —"),
            "pagina": m.get("pagina", 1), "url": m.get("url_oficial", ""),
        })
    indice = [e for e in nuevos if (e["fecha"], e["numero"]) not in existentes] + indice
    ruta_indice.write_text(json.dumps(indice, ensure_ascii=False, indent=0), encoding="utf-8")

    # 3) Puntero "ultimo.json" con el archivo de titulares
    ruta_ultimo = DATA / "ultimo.json"
    ultimo = json.loads(ruta_ultimo.read_text(encoding="utf-8")) if ruta_ultimo.exists() else {"archivo": []}
    titulares = [n.get("titulo", "") for n in despacho.get("normas", [])[:2]]
    entrada = {"fecha": str(HOY), "numero": nro,
               "titular": ("; ".join(t for t in titulares if t))[:160] + "."}
    archivo = [e for e in ultimo.get("archivo", []) if e.get("fecha") != str(HOY)]
    ultimo = {"hoy": str(HOY), "archivo": ([entrada] + archivo)[:90]}
    ruta_ultimo.write_text(json.dumps(ultimo, ensure_ascii=False, indent=1), encoding="utf-8")

def guardar_texto(paginas_por_seccion: dict, urls: dict) -> None:
    """Archiva el texto extraído, página por página.

    El índice guarda (fecha, sección, página) de cada norma. Con el texto
    archivado, cualquier norma del índice —destacada o no— se puede ubicar
    y resumir después, sin volver a pedirle el PDF al Boletín (que desde
    fuera de una IP hogareña responde 403). Son ~100 KB por día.

    Acumula en vez de pisar: si un día se corrió con --secciones 1,4 y más
    tarde con 1,3, el archivo termina con las tres. Bajar una sección es
    barato; recuperarla meses después, cuando el PDF ya no esté, no."""
    TEXTO.mkdir(parents=True, exist_ok=True)
    ruta = TEXTO / f"{HOY}.json"
    archivo = json.loads(ruta.read_text(encoding="utf-8")) if ruta.exists() else {}
    secciones = archivo.get("secciones", {})
    for s, pags in paginas_por_seccion.items():
        secciones[s] = {"url": urls.get(s, ""), "paginas": pags}
    ruta.write_text(json.dumps({"fecha": str(HOY),
                                "secciones": dict(sorted(secciones.items()))},
                               ensure_ascii=False), encoding="utf-8")


# --------------------------------- Avisos ---------------------------------

def avisar(despacho: dict, degradado: bool = False) -> None:
    nro = despacho.get("numero_boletin", "s/d")
    app_url = os.environ.get("APP_URL", "")
    texto = despacho.get("telegram") or (
        f"📋 Salió el B.O. N° {nro} — resumen listo."
    )
    if degradado:
        # Que se vea. Si el análisis lo escribió el suplente, hay que saberlo
        # antes de reenviárselo a alguien.
        texto = (f"⚠️ Escrito por el motor de respaldo "
                 f"({despacho.get('motor', '?')}) — revisar antes de reenviar.\n\n"
                 + texto)
    if app_url:
        texto += f"\n{app_url}"

    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat = os.environ.get("TELEGRAM_CHAT_ID")
    if token and chat:
        try:
            requests.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={"chat_id": chat, "text": texto},
                timeout=30,
            ).raise_for_status()
            print("Aviso de Telegram enviado.")
        except Exception as e:  # el aviso nunca debe tirar abajo la corrida
            print(f"⚠️  Telegram falló: {e}")

    usuario = os.environ.get("GMAIL_USUARIO")
    clave = os.environ.get("GMAIL_CLAVE_APP")
    if usuario and clave:
        try:
            cuerpo = "\n\n".join(despacho.get("sintesis_juridica", []) +
                                 despacho.get("sintesis_politica", []))
            if app_url:
                cuerpo += f"\n\nVer el despacho completo: {app_url}"
            msj = MIMEText(cuerpo, "plain", "utf-8")
            msj["Subject"] = f"Despacho Diario — B.O. N° {nro} ({HOY})"
            msj["From"] = usuario
            msj["To"] = usuario
            with smtplib.SMTP_SSL("smtp.gmail.com", 465) as s:
                s.login(usuario, clave)
                s.send_message(msj)
            print("Correo enviado.")
        except Exception as e:
            print(f"⚠️  Correo falló: {e}")

def avisar_error(mensaje: str) -> None:
    """Aviso de emergencia por Telegram cuando la corrida falla."""
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat = os.environ.get("TELEGRAM_CHAT_ID")
    if not (token and chat):
        return
    try:
        requests.post(f"https://api.telegram.org/bot{token}/sendMessage",
                      json={"chat_id": chat, "text": mensaje}, timeout=30)
    except Exception:
        pass

# ---------------------------------- Main ----------------------------------

def leer_argumentos() -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description="Genera el despacho de una edición del Boletín Oficial de Córdoba.")
    ap.add_argument("--fecha", metavar="AAAA-MM-DD",
                    help="Edición a procesar. Por defecto, hoy en Córdoba. "
                         "Sirve para recuperar un día que no se corrió: los PDF "
                         "viejos siguen publicados.")
    ap.add_argument("--rehacer", action="store_true",
                    help="Regenera el despacho aunque ya exista (lo pisa).")
    ap.add_argument("--secciones", metavar="N,N",
                    help=f"Secciones del Boletín a monitorear, separadas por coma. "
                         f"Por defecto {','.join(SECCIONES)}. "
                         f"1=Legislación 2=Judiciales 3=Sociedades "
                         f"4=Licitaciones 5=Varios.")
    ap.add_argument("--motor", choices=("claude", "gemini"),
                    help=f"Motor de IA primario. Por defecto {MOTOR}. "
                         f"Si falla, se intenta con el respaldo igual.")
    return ap.parse_args()


def resolver_secciones(pedido: str | None) -> list[str]:
    """'1,4,5' → ['1','4','5']. Sin argumento, las de SECCIONES."""
    if not pedido:
        return list(SECCIONES)
    elegidas = [s.strip() for s in pedido.split(",") if s.strip()]
    invalidas = [s for s in elegidas if s not in "12345" or len(s) != 1]
    if invalidas:
        raise SystemExit(f"Secciones inválidas: {', '.join(invalidas)}. "
                         f"Son dígitos del 1 al 5.")
    return list(dict.fromkeys(elegidas))    # sin repetidos, en orden


def main() -> None:
    global HOY
    args = leer_argumentos()
    if args.fecha:
        try:
            HOY = dt.date.fromisoformat(args.fecha)
        except ValueError:
            raise SystemExit(f"Fecha inválida: {args.fecha!r}. Usá AAAA-MM-DD.")

    print(f"— Despacho Diario · {HOY} —")

    if (DATA / f"{HOY}.json").exists() and not args.rehacer:
        print("El despacho de esa fecha ya está publicado; nada que hacer "
              "(usá --rehacer para regenerarlo).")
        return

    secciones = resolver_secciones(args.secciones)
    motor = args.motor or MOTOR
    print(f"Secciones: {', '.join(secciones)} · motor: {motor}"
          + (f" (respaldo: {MOTOR_RESPALDO})" if MOTOR_RESPALDO else ""))

    try:
        pdfs = descargar_pdfs(secciones)
    except NotImplementedError as e:
        print(f"⚠️  {e}")
        return

    if not pdfs:
        print("El boletín de hoy aún no está publicado; la próxima corrida reintenta.")
        return

    urls, partes, paginas_por_seccion = {}, [], {}
    for seccion, contenido, url in pdfs:
        urls[seccion] = url
        paginas = extraer_paginas(contenido)
        paginas_por_seccion[seccion] = paginas
        partes.append(f"\n\n##### SECCIÓN {seccion} #####\n\n" + con_marcadores(paginas))
    texto = "".join(partes)
    if len(texto) < 2000:
        raise RuntimeError("El texto extraído vino casi vacío (¿PDF escaneado o dañado?).")

    # El texto ya está archivado: aunque el análisis no entre o la IA falle,
    # el día no se pierde y se puede reintentar con --rehacer.
    guardar_texto(paginas_por_seccion, urls)

    if len(texto) > LIMITE_CARACTERES:
        detalle = " · ".join(
            f"secc. {s}: {sum(len(x) for x in pags) // 1000}k"
            for s, pags in paginas_por_seccion.items())
        raise RuntimeError(
            f"Las secciones elegidas suman {len(texto) // 1000} mil caracteres y no "
            f"entran en una sola llamada (tope: {LIMITE_CARACTERES // 1000} mil).\n"
            f"   Desglose → {detalle}\n"
            f"   El texto quedó archivado igual. Sacá la sección más pesada "
            f"(normalmente la 2ª, Judiciales) y volvé a correr con --secciones.")

    nro = detectar_numero_boletin(texto)
    print(f"Boletín N° {nro} · ~{len(texto) // 1000} mil caracteres")

    despacho, motor_usado = llamar_api(texto, motor)
    despacho.setdefault("numero_boletin", nro)
    despacho["motor"] = motor_usado
    if motor_usado != motor:
        print(f"⚠️  El despacho de hoy lo escribió {motor_usado}, no {motor}.")

    guardar(despacho, urls)
    avisar(despacho, degradado=(motor_usado != motor))
    print(f"✅ Despacho generado con {motor_usado} y guardado en docs/data/.")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"❌ Error: {e}")
        avisar_error(f"⚠️ Despacho Diario: la corrida de hoy FALLÓ.\n{e}\nRevisá: cat ~/despacho-cordoba/despacho.log")
        sys.exit(1)
