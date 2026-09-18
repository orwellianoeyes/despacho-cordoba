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
};

const TIPOS = ["Ley", "Decreto", "Resolución", "Licitación", "Edicto", "Subasta"];

export default function Buscador() {
  const supabase = clienteNavegador();
  const [q, setQ] = useState("");
  const [tipo, setTipo] = useState("");
  const [filas, setFilas] = useState<Norma[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [cargando, setCargando] = useState(false);
  const [abierta, setAbierta] = useState<number | null>(null);
  const [resumiendo, setResumiendo] = useState<number | null>(null);
  const [error, setError] = useState("");

  const buscar = useCallback(async () => {
    setCargando(true); setError("");
    let consulta = supabase
      .from("normas")
      .select("id,fecha,tipo,numero,titulo,seccion,pagina,url_oficial,destacada,importa,ampliada,analizada_por",
              { count: "exact" })
      .order("fecha", { ascending: false })
      .limit(40);

    // La búsqueda la resuelve Postgres con el índice de texto completo en
    // español, no el navegador filtrando un JSON entero.
    if (q.trim()) consulta = consulta.textSearch("busqueda", q.trim(), {
      type: "plain", config: "spanish",
    });
    if (tipo) consulta = consulta.ilike("tipo", `${tipo}%`);

    const { data, error, count } = await consulta;
    if (error) setError(error.message);
    setFilas((data as Norma[]) ?? []);
    setTotal(count ?? null);
    setCargando(false);
  }, [q, tipo, supabase]);

  useEffect(() => {
    const t = setTimeout(buscar, 250);   // no consultar en cada tecla
    return () => clearTimeout(t);
  }, [buscar]);

  async function resumir(id: number) {
    setResumiendo(id); setError("");
    try {
      const r = await fetch("/api/resumir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const cuerpo = await r.json();
      if (!r.ok) throw new Error(cuerpo.error || "no se pudo resumir");
      setFilas((prev) => prev.map((n) => (n.id === id
        ? { ...n, ampliada: cuerpo.ampliada, importa: cuerpo.importa,
            analizada_por: cuerpo.motor }
        : n)));
      setAbierta(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setResumiendo(null);
    }
  }

  return (
    <div className="marco">
      <Cabecera activa="/buscador" />

      <div className="busca-caja">
        <div className="busca-fila">
          <input
            type="search" value={q} onChange={(e) => setQ(e.target.value)}
            aria-label="Buscar normativa"
            placeholder="Buscar por número o palabra clave — ej.: emergencia hídrica, APROSS, 812"
          />
          <select value={tipo} onChange={(e) => setTipo(e.target.value)} aria-label="Filtrar por tipo">
            <option value="">Todos los tipos</option>
            {TIPOS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <p className="nota">
          {cargando ? "Buscando…"
            : total === null ? ""
            : `${total} resultado${total === 1 ? "" : "s"}${total > filas.length ? ` · se muestran ${filas.length}` : ""}`}
        </p>
        {error && <p className="error">{error}</p>}

        {filas.map((n) => (
          <div key={n.id}>
            <div className="resultado">
              <span className="f-fecha">{n.fecha}</span>
              <span>
                <span className="chip">{n.tipo || "—"}</span>
                {n.ampliada && <span className="chip analizada">analizada</span>}
                <br />
                {n.titulo} <span className="f-num">· {n.numero}</span>
              </span>
              <span className="acciones">
                {n.ampliada ? (
                  <button className="btn" onClick={() => setAbierta(abierta === n.id ? null : n.id)}>
                    {abierta === n.id ? "Cerrar" : "Ver análisis"}
                  </button>
                ) : (
                  <button className="btn sello" onClick={() => resumir(n.id)}
                          disabled={resumiendo === n.id}>
                    {resumiendo === n.id ? "Analizando…" : "Resumir con IA"}
                  </button>
                )}
                {n.url_oficial && (
                  <a className="btn" href={`${n.url_oficial}#page=${n.pagina}`}
                     target="_blank" rel="noopener">PDF · pág. {n.pagina} ↗</a>
                )}
              </span>
            </div>

            {abierta === n.id && n.ampliada && (
              <div className="panel-analisis">
                <p className="rotulo">Síntesis ampliada</p>
                {n.importa && <p className="amp"><b>Por qué importa.</b> {n.importa}</p>}
                <p className="amp"><b className="lab-j">Lo jurídico.</b> {n.ampliada.juridica}</p>
                <p className="amp"><b className="lab-p">Lo político.</b> {n.ampliada.politica}</p>
                <p className="amp mirada"><b>Mirada oficialista.</b> {n.ampliada.oficialista}</p>
                <p className="amp mirada"><b>Mirada opositora.</b> {n.ampliada.opositora}</p>
                <p className="aviso-ia">
                  Análisis generado con IA{n.analizada_por ? ` (${n.analizada_por})` : ""} a
                  partir del texto oficial · contrastar con el Boletín antes de citarlo.
                </p>
              </div>
            )}
          </div>
        ))}

        {!cargando && total === 0 && (
          <p className="nota">Sin resultados. Probá con el número de la norma o una palabra del título.</p>
        )}
      </div>
      <div style={{ height: 60 }} />
    </div>
  );
}
