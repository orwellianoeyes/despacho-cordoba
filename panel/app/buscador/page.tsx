"use client";

import { useCallback, useEffect, useState } from "react";
import { Cabecera } from "../componentes";
import { clienteNavegador } from "@/lib/supabase/navegador";

type Ampliada = {
  juridica?: string; politica?: string;
  oficialista?: string; opositora?: string;
};
type Norma = {
  id: number; fecha: string; tipo: string; numero: string; titulo: string;
  seccion: string; pagina: number; url_oficial: string | null;
  destacada: boolean; importa: string | null;
  ampliada: Ampliada | null; analizada_por: string | null;
  extenso: string | null; extenso_por: string | null;
};
type Abierto = { id: number; vista: "corto" | "extenso" | "texto" } | null;

// Antes eran 40 con `limit` y sin salida: la pantalla avisaba "se muestran
// 40 de 113" y no daba ninguna forma de llegar a las otras 73.
const POR_PAGINA = 25;
const TIPOS = ["Ley", "Decreto", "Resolución", "Licitación", "Edicto", "Subasta"];
const COLUMNAS =
  "id,fecha,tipo,numero,titulo,seccion,pagina,url_oficial,destacada," +
  "importa,ampliada,analizada_por,extenso,extenso_por";

// Markdown mínimo: el instructivo produce títulos ##, párrafos y listas.
// No vale traer una librería entera para eso.
function Markdown({ texto }: { texto: string }) {
  const bloques = texto.split(/\n{2,}/);
  return (
    <>
      {bloques.map((b, i) => {
        const t = b.trim();
        if (t.startsWith("## ")) return <h3 key={i} className="md-h">{t.slice(3)}</h3>;
        if (t.startsWith("# ")) return <h3 key={i} className="md-h">{t.slice(2)}</h3>;
        if (/^[-*] /m.test(t)) {
          return (
            <ul key={i} className="md-lista">
              {t.split("\n").map((l, j) => <li key={j}>{l.replace(/^[-*]\s*/, "")}</li>)}
            </ul>
          );
        }
        return <p key={i} className="amp">{t}</p>;
      })}
    </>
  );
}

export default function Buscador() {
  const supabase = clienteNavegador();
  const [q, setQ] = useState("");
  const [tipo, setTipo] = useState("");
  const [edicion, setEdicion] = useState("");
  const [enviando, setEnviando] = useState<Norma | null>(null);
  const [ediciones, setEdiciones] = useState<string[]>([]);
  const [filas, setFilas] = useState<Norma[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [pagina, setPagina] = useState(0);
  const [cargando, setCargando] = useState(false);
  const [abierto, setAbierto] = useState<Abierto>(null);
  const [trabajando, setTrabajando] = useState<string | null>(null);
  const [textos, setTextos] = useState<Record<number, string>>({});
  const [error, setError] = useState("");

  const buscar = useCallback(async () => {
    setCargando(true); setError("");
    let consulta = supabase.from("normas").select(COLUMNAS, { count: "exact" })
      .order("fecha", { ascending: false })
      .range(pagina * POR_PAGINA, pagina * POR_PAGINA + POR_PAGINA - 1);

    // La búsqueda la resuelve Postgres con el índice de texto completo, que
    // está armado para encontrar con y sin tildes.
    if (q.trim()) consulta = consulta.textSearch("busqueda", q.trim(), {
      type: "plain", config: "spanish",
    });
    if (tipo) consulta = consulta.ilike("tipo", `${tipo}%`);
    if (edicion) consulta = consulta.eq("fecha", edicion);

    const { data, error, count } = await consulta;
    if (error) setError(error.message);
    setFilas((data as unknown as Norma[]) ?? []);
    setTotal(count ?? null);
    setCargando(false);
  }, [q, tipo, edicion, pagina, supabase]);

  useEffect(() => { setPagina(0); }, [q, tipo, edicion]);

  useEffect(() => {
    const t = setTimeout(buscar, 250);   // no consultar en cada tecla
    return () => clearTimeout(t);
  }, [buscar]);

  // Para poder mirar UNA edición entera. Sin esto solo se podía buscar por
  // palabra, y "qué salió hoy" no es una búsqueda por palabra.
  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("despachos").select("fecha")
        .order("fecha", { ascending: false }).limit(60);
      setEdiciones((data ?? []).map((d: { fecha: string }) => d.fecha));
    })();
  }, [supabase]);

  async function analizar(id: number, modo: "corto" | "extenso") {
    setTrabajando(`${id}:${modo}`); setError("");
    try {
      const r = await fetch("/api/resumir", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, modo }),
      });
      const c = await r.json();
      if (!r.ok) throw new Error(c.error || "no se pudo analizar");
      setFilas((prev) => prev.map((n) => n.id !== id ? n : modo === "extenso"
        ? { ...n, extenso: c.extenso, extenso_por: c.motor }
        : { ...n, ampliada: c.ampliada, importa: c.importa, analizada_por: c.motor }));
      setAbierto({ id, vista: modo });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTrabajando(null);
    }
  }

  async function verTexto(n: Norma) {
    if (abierto?.id === n.id && abierto.vista === "texto") { setAbierto(null); return; }
    setAbierto({ id: n.id, vista: "texto" });
    if (textos[n.id]) return;
    const { data } = await supabase.from("paginas").select("texto")
      .eq("fecha", n.fecha).eq("seccion", n.seccion).eq("pagina", n.pagina).maybeSingle();
    setTextos((t) => ({ ...t, [n.id]: data?.texto ?? "(no hay texto archivado de esa página)" }));
  }

  const alterna = (id: number, vista: "corto" | "extenso") =>
    setAbierto(abierto?.id === id && abierto.vista === vista ? null : { id, vista });

  return (
    <div className="marco">
      <Cabecera activa="/buscador" />

      <div className="busca-caja">
        <div className="busca-fila">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)}
            aria-label="Buscar normativa"
            placeholder="Buscar por número o palabra clave — ej.: emergencia hidrica, APROSS, 812" />
          <select value={edicion} onChange={(e) => setEdicion(e.target.value)}
                  aria-label="Filtrar por edición">
            <option value="">Todas las ediciones</option>
            {ediciones.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <select value={tipo} onChange={(e) => setTipo(e.target.value)} aria-label="Filtrar por tipo">
            <option value="">Todos los tipos</option>
            {TIPOS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <p className="nota">
          {cargando ? "Buscando…" : total === null ? ""
            : total === 0 ? "sin resultados"
            : `${total} resultado${total === 1 ? "" : "s"}`
              + (total > POR_PAGINA
                  ? ` · ${pagina * POR_PAGINA + 1} a ${Math.min((pagina + 1) * POR_PAGINA, total)}`
                  : "")}
        </p>
        {error && <p className="error">{error}</p>}

        {filas.map((n) => {
          const abierta = abierto?.id === n.id ? abierto.vista : null;
          return (
            <div key={n.id}>
              <div className="resultado">
                <span className="f-fecha">{n.fecha}</span>
                <span>
                  <span className="chip">{n.tipo || "—"}</span>
                  {n.ampliada && <span className="chip analizada">resumida</span>}
                  {n.extenso && <span className="chip extensa">análisis extenso</span>}
                  <br />
                  {n.titulo} <span className="f-num">· {n.numero}</span>
                </span>
                <span className="acciones">
                  {n.ampliada ? (
                    <button className="btn" onClick={() => alterna(n.id, "corto")}>
                      {abierta === "corto" ? "Cerrar" : "Resumen"}
                    </button>
                  ) : (
                    <button className="btn" onClick={() => analizar(n.id, "corto")}
                            disabled={trabajando === `${n.id}:corto`}>
                      {trabajando === `${n.id}:corto` ? "Resumiendo…" : "Resumir"}
                    </button>
                  )}
                  {n.extenso ? (
                    <button className="btn sello" onClick={() => alterna(n.id, "extenso")}>
                      {abierta === "extenso" ? "Cerrar" : "Ver extenso"}
                    </button>
                  ) : (
                    <button className="btn sello" onClick={() => analizar(n.id, "extenso")}
                            disabled={trabajando === `${n.id}:extenso`}>
                      {trabajando === `${n.id}:extenso` ? "Analizando…" : "Análisis extenso"}
                    </button>
                  )}
                  <button className="btn" onClick={() => verTexto(n)}>
                    {abierta === "texto" ? "Cerrar texto" : "Texto oficial"}
                  </button>
                  {n.url_oficial && (
                    <a className="btn" href={`${n.url_oficial}#page=${n.pagina}`}
                       target="_blank" rel="noopener">PDF ↗</a>
                  )}
                  {/* Para cuando el cliente pide algo que su encargo no
                      cubre. Antes ese pedido no tenía por dónde salir: el
                      panel solo sabía mandar lo que había matcheado. */}
                  <button className="btn" onClick={() => setEnviando(n)}>Enviar a…</button>
                </span>
              </div>

              {enviando?.id === n.id && (
                <EnviarSuelta norma={n} alCerrar={() => setEnviando(null)} />
              )}

              {abierta === "corto" && n.ampliada && (
                <div className="panel-analisis">
                  <p className="rotulo">Síntesis ampliada</p>
                  {n.importa && <p className="amp"><b>Por qué importa.</b> {n.importa}</p>}
                  {/* Las cuatro en cuadrícula, no apiladas: jurídico contra
                      político arriba, oficialista contra opositora abajo. El
                      par opuesto queda lado a lado, que es como se compara. */}
                  <div className="miradas">
                    {([["Lo jurídico", n.ampliada.juridica, "j"],
                       ["Lo político", n.ampliada.politica, "p"],
                       ["Mirada oficialista", n.ampliada.oficialista, "o"],
                       ["Mirada opositora", n.ampliada.opositora, "c"]] as const)
                      .filter(([, txt]) => txt)
                      .map(([rotulo, txt, clase]) => (
                        <div key={rotulo} className="mirada">
                          <p className={`mirada-rotulo m-${clase}`}>{rotulo}</p>
                          <p className="amp">{txt}</p>
                        </div>
                      ))}
                  </div>
                  <p className="aviso-ia">
                    Generado con IA{n.analizada_por ? ` (${n.analizada_por})` : ""} a partir del
                    texto oficial · contrastar con el Boletín antes de citarlo.
                  </p>
                </div>
              )}

              {abierta === "extenso" && n.extenso && (
                <div className="panel-analisis extenso">
                  <p className="rotulo">Análisis extenso</p>
                  <Markdown texto={n.extenso} />
                  <p className="aviso-ia">
                    Generado con IA{n.extenso_por ? ` (${n.extenso_por})` : ""} a partir del
                    texto oficial · contrastar con el Boletín antes de citarlo.
                  </p>
                </div>
              )}

              {abierta === "texto" && (
                <div className="panel-analisis texto-crudo">
                  <p className="rotulo">
                    Texto oficial · sección {n.seccion}, página {n.pagina}
                  </p>
                  <pre className="crudo">{textos[n.id] ?? "Cargando…"}</pre>
                </div>
              )}
            </div>
          );
        })}

        {!cargando && total === 0 && (
          <p className="nota">Sin resultados. Probá con el número de la norma o una palabra del título.</p>
        )}

        {total !== null && total > POR_PAGINA && (() => {
          const paginas = Math.ceil(total / POR_PAGINA);
          // Una ventana de cinco alrededor de donde estás: hoy el archivo da
          // pocas páginas, pero crece todos los días hábiles.
          const desde = Math.max(0, Math.min(pagina - 2, paginas - 5));
          const ir = (n: number) => {
            setPagina(n);
            window.scrollTo({ top: 0, behavior: "smooth" });
          };
          return (
            <div className="paginas">
              <span className="nota" style={{ margin: 0 }}>
                página {pagina + 1} de {paginas}
              </span>
              <span className="acciones">
                <button className="btn pag" disabled={pagina === 0}
                        onClick={() => ir(pagina - 1)}>‹ anterior</button>
                {Array.from({ length: Math.min(5, paginas) }, (_, i) => desde + i)
                  .map((n) => (
                    <button key={n} className={`btn pag ${n === pagina ? "aqui" : ""}`}
                            onClick={() => ir(n)}>{n + 1}</button>
                  ))}
                <button className="btn pag" disabled={pagina + 1 >= paginas}
                        onClick={() => ir(pagina + 1)}>siguiente ›</button>
              </span>
            </div>
          );
        })()}
      </div>
      <div style={{ height: 60 }} />
    </div>
  );
}

// Mandar UNA norma a alguien, fuera de su encargo. El caso real: el
// cliente escribe "¿qué pasó con la ruta 9?" y eso no está entre sus
// temas, así que no aparece en Entregas.
//
// Reusa /api/entregar por el camino `contacto_id`, con lo cual hereda lo
// que importa: la vista previa se edita, el tope de Telegram se controla,
// y queda en la bitácora con el texto que realmente salió.
function EnviarSuelta({ norma, alCerrar }:
                      { norma: Norma; alCerrar: () => void }) {
  const supabase = clienteNavegador();
  const [gente, setGente] = useState<{ id: number; nombre: string }[]>([]);
  const [quien, setQuien] = useState<number | null>(null);
  const [formato, setFormato] = useState("completo");
  const [previa, setPrevia] = useState<{ texto: string; tope: number } | null>(null);
  const [borrador, setBorrador] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      // Solo los que pueden recibir: sin Telegram vinculado no hay envío.
      const { data } = await supabase.from("contactos")
        .select("id,nombre").eq("activo", true)
        .not("telegram_id", "is", null).order("nombre");
      const g = (data ?? []) as { id: number; nombre: string }[];
      setGente(g);
      if (g.length === 1) setQuien(g[0].id);
    })();
  }, [supabase]);

  async function pedir(soloPrevia: boolean) {
    if (!quien) return;
    setOcupado(true); setError(""); setAviso("");
    try {
      const r = await fetch("/api/entregar", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contacto_id: quien, fecha: norma.fecha, ids: [norma.id], formato,
          previa: soloPrevia, texto: soloPrevia ? undefined : borrador,
        }),
      });
      const c = await r.json();
      if (!r.ok) throw new Error(c.error || "falló");
      if (soloPrevia) { setPrevia(c); setBorrador(c.texto); }
      else { setAviso("Enviado."); setPrevia(null); setTimeout(alCerrar, 1500); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setOcupado(false); }
  }

  return (
    <div className="panel-analisis enviar">
      <p className="rotulo">Enviar esta norma a un contacto</p>

      {gente.length === 0 ? (
        <p className="nota">
          Ninguno de tus contactos tiene Telegram vinculado todavía, así que
          no hay a quién mandársela. Se vincula desde Contactos.
        </p>
      ) : (
        <>
          <div className="busca-fila" style={{ marginTop: 10 }}>
            <select value={quien ?? ""} aria-label="A quién"
                    onChange={(e) => { setQuien(Number(e.target.value) || null);
                                       setPrevia(null); }}>
              <option value="">¿A quién?</option>
              {gente.map((g) => <option key={g.id} value={g.id}>{g.nombre}</option>)}
            </select>
            <select value={formato} aria-label="Formato"
                    onChange={(e) => { setFormato(e.target.value); setPrevia(null); }}>
              <option value="breve">Con resumen</option>
              <option value="completo">Completo · las cuatro miradas</option>
              <option value="extenso">Extenso</option>
            </select>
            <button className="btn" disabled={!quien || ocupado}
                    onClick={() => pedir(true)}>
              {ocupado && !previa ? "Armando…" : "Ver vista previa"}
            </button>
          </div>

          {previa && (
            <>
              <p className="nota">
                <span className={borrador.length > previa.tope ? "calibre mal" : "calibre"}>
                  {borrador.length} de {previa.tope} caracteres
                </span>
                {borrador !== previa.texto && <span className="calibre ok"> · editado</span>}
              </p>
              <textarea className="crudo editable" value={borrador} spellCheck
                        onChange={(e) => setBorrador(e.target.value)} />
            </>
          )}

          <div className="acciones" style={{ marginTop: 12 }}>
            <button className="btn sello" disabled={ocupado || !previa
                                                    || !borrador.trim()
                                                    || borrador.length > (previa?.tope ?? 0)}
                    onClick={() => pedir(false)}>
              {ocupado && previa ? "Enviando…" : "Enviar por Telegram"}
            </button>
            <button className="btn" onClick={alCerrar}>Cancelar</button>
          </div>
        </>
      )}

      {aviso && <p className="calibre ok" style={{ marginTop: 10 }}>{aviso}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
