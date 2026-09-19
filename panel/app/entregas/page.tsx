"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Cabecera } from "../componentes";
import { clienteNavegador } from "@/lib/supabase/navegador";

type Pendiente = {
  encargo_id: number; etiqueta: string; temas: string[];
  contacto_id: number; contacto: string; telegram_id: number | null;
  cuantas: number; ya_entregada: boolean;
};
type Norma = {
  id: number; tipo: string; numero: string; titulo: string;
  seccion: string; pagina: number; url_oficial: string | null;
  destacada: boolean; importa: string | null;
  ampliada: Record<string, string> | null;
  extenso: string | null;
  temas_que_pegaron: string[];
};
type Formato = "titulares" | "breve" | "completo" | "extenso";

// Medido sobre las 335 normas analizadas: cuánto ocupa cada una según el
// formato. Sirve para avisar que no entra ANTES de armar el mensaje.
const PESO: Record<Formato, number> = {
  titulares: 240, breve: 512, completo: 1652, extenso: 9000,
};
const TOPE = 4096;

// Una escalera: cada peldaño contesta una pregunta más.
const FORMATOS: [Formato, string, string][] = [
  ["titulares", "Titulares", "qué salió, con monto y fecha · entran ~15"],
  ["breve",     "Con resumen", "y de qué se trata cada una · entran ~8"],
  ["completo",  "Completo",  "con las cuatro miradas · entran ~2"],
  ["extenso",   "Extenso",   "el análisis en profundidad · de a una"],
];

export default function Entregas() {
  const supabase = clienteNavegador();
  const [fechas, setFechas] = useState<string[]>([]);
  const [fecha, setFecha] = useState("");
  const [pendientes, setPendientes] = useState<Pendiente[]>([]);
  const [abierto, setAbierto] = useState<number | null>(null);
  const [normas, setNormas] = useState<Norma[]>([]);
  const [elegidas, setElegidas] = useState<Set<number>>(new Set());
  const [previa, setPrevia] = useState<{ texto: string; largo: number; tope: number } | null>(null);
  const [borrador, setBorrador] = useState("");
  const [formato, setFormato] = useState<Formato>("titulares");
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("despachos").select("fecha")
        .order("fecha", { ascending: false }).limit(60);
      const f = (data ?? []).map((d: { fecha: string }) => d.fecha);
      setFechas(f);
      if (f.length) setFecha(f[0]);
    })();
  }, [supabase]);

  const cargar = useCallback(async () => {
    if (!fecha) return;
    setError(""); setAbierto(null); setPrevia(null);
    const { data, error } = await supabase.rpc("pendientes_del_dia", { p_fecha: fecha });
    if (error) setError(error.message);
    setPendientes((data as Pendiente[]) ?? []);
  }, [fecha, supabase]);

  useEffect(() => { cargar(); }, [cargar]);

  async function abrir(p: Pendiente) {
    if (abierto === p.encargo_id) { setAbierto(null); return; }
    setAbierto(p.encargo_id); setPrevia(null); setError(""); setFormato("titulares");
    const { data } = await supabase.rpc("normas_del_encargo",
      { p_encargo: p.encargo_id, p_fecha: fecha });
    const ns = (data as Norma[]) ?? [];
    setNormas(ns);
    setElegidas(new Set(ns.map((n) => n.id)));   // todas marcadas por defecto
  }

  async function pedir(encargo_id: number, previaSola: boolean) {
    setOcupado(true); setError(""); setAviso("");
    try {
      const r = await fetch("/api/entregar", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ encargo_id, fecha, previa: previaSola, formato,
                               ids: [...elegidas],
                               texto: previaSola ? undefined : borrador }),
      });
      const c = await r.json();
      if (!r.ok) throw new Error(c.error || "falló");
      if (previaSola) { setPrevia(c); setBorrador(c.texto); }
      else { setAviso(c.aviso ?? `Enviado: ${c.cuantas} normas.`); setPrevia(null); cargar(); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setOcupado(false); }
  }

  const alterna = (id: number) => setElegidas((s) => {
    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n;
  });

  return (
    <div className="marco">
      <Cabecera activa="/entregas" />

      <section style={{ marginTop: 28 }}>
        <div className="fila-titulo">
          <h2>Qué hay para quién</h2>
          <select value={fecha} onChange={(e) => setFecha(e.target.value)} aria-label="Edición">
            {fechas.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
        <p className="nota">
          El sistema prepara; vos despachás. Nada sale sin que lo hayas visto.
        </p>
        {error && <p className="error">{error}</p>}
        {aviso && <p className="ok">{aviso}</p>}

        {!pendientes.length && (
          <div className="vacio-guia">
            <p>Todavía no hay encargos activos.</p>
            <p className="nota">
              Un encargo es lo que define qué le llega a cada contacto: un nombre,
              los temas a vigilar y las secciones a mirar. Sin eso, esta pantalla
              no tiene nada que preparar.
            </p>
            <Link className="btn sello" href="/contactos" style={{ marginTop: 14 }}>
              Ir a Contactos y crear el primero →
            </Link>
          </div>
        )}

        {pendientes.map((p) => (
          <div key={p.encargo_id} className="ficha">
            <div className="ficha-cab">
              <div>
                <h3 className="ficha-nombre">{p.contacto}</h3>
                <p className="nota" style={{ marginTop: 2 }}>
                  {p.etiqueta} · {p.temas.map((t) => <span key={t} className="chip tema">{t}</span>)}
                </p>
              </div>
              <span className="acciones">
                <span className={`cuenta ${p.cuantas ? "hay" : ""}`}>
                  {p.cuantas} {p.cuantas === 1 ? "norma" : "normas"}
                </span>
                {p.ya_entregada && <span className="chip analizada">ya enviada</span>}
                {!p.telegram_id && <span className="chip mal">sin Telegram</span>}
                {p.cuantas > 0 && (
                  <button className="btn" onClick={() => abrir(p)}>
                    {abierto === p.encargo_id ? "Cerrar" : "Revisar"}
                  </button>
                )}
              </span>
            </div>

            {abierto === p.encargo_id && (
              <div className="revision">
                <p className="rotulo">Formato del mensaje</p>
                <div className="formatos">
                  {FORMATOS.map(([f, nombre, ayuda]) => (
                    <label key={f} className={`formato ${formato === f ? "elegido" : ""}`}>
                      <input type="radio" name={`fmt-${p.encargo_id}`} checked={formato === f}
                             onChange={() => { setFormato(f); setPrevia(null); }} />
                      <span><b>{nombre}</b><br /><span className="nota">{ayuda}</span></span>
                    </label>
                  ))}
                </div>

                <p className="nota" style={{ marginTop: 12 }}>
                  {elegidas.size} de {normas.length} marcadas · destildá lo que no quieras mandar
                  {(() => {
                    const est = elegidas.size * PESO[formato] + 200;
                    if (est <= TOPE) return null;
                    const caben = Math.max(1, Math.floor(TOPE / PESO[formato]));
                    return <span className="calibre mal"> · no van a entrar: en
                      formato {formato} caben unas {caben}</span>;
                  })()}
                </p>
                {normas.map((n) => (
                  <label key={n.id} className="norma-check">
                    <input type="checkbox" checked={elegidas.has(n.id)}
                           onChange={() => alterna(n.id)} />
                    <span>
                      <span className="chip">{n.tipo}</span>
                      {n.temas_que_pegaron.map((t) => (
                        <span key={t} className="chip tema">{t}</span>
                      ))}
                      {!n.ampliada && <span className="chip mal">sin análisis</span>}
                      <br />
                      {n.titulo} <span className="f-num">· {n.numero}</span>
                    </span>
                  </label>
                ))}

                <div style={{ marginTop: 14 }}>
                  <button className="btn" disabled={ocupado || !elegidas.size}
                          onClick={() => pedir(p.encargo_id, true)}>
                    {ocupado ? "…" : "Ver el mensaje"}
                  </button>
                  <button className="btn sello" style={{ marginLeft: 8 }}
                          disabled={ocupado || !elegidas.size || !p.telegram_id
                                    || !previa || !borrador.trim()
                                    || borrador.length > previa.tope}
                          onClick={() => pedir(p.encargo_id, false)}>
                    Enviar por Telegram
                  </button>
                  {!previa && (
                    <span className="nota" style={{ marginLeft: 10 }}>
                      hay que ver el mensaje antes de poder enviarlo
                    </span>
                  )}
                </div>

                {previa && (
                  <div className="panel-analisis texto-crudo" style={{ marginTop: 14 }}>
                    <p className="rotulo">
                      Esto es lo que va a recibir — se puede editar ·{" "}
                      <span className={borrador.length > previa.tope ? "calibre mal" : "calibre"}>
                        {borrador.length} de {previa.tope} caracteres
                      </span>
                      {borrador !== previa.texto && <span className="calibre ok"> · editado</span>}
                    </p>
                    <textarea className="crudo editable" value={borrador} spellCheck
                              onChange={(e) => setBorrador(e.target.value)} />
                    <p className="nota">
                      Sale exactamente esto, con tus cambios. Se guarda en la bitácora
                      el texto que realmente salió, no el borrador automático.
                      {borrador !== previa.texto && (
                        <> · <button className="btn mini" style={{ marginLeft: 6 }}
                             onClick={() => setBorrador(previa.texto)}>Volver al original</button></>
                      )}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </section>
      <div style={{ height: 60 }} />
    </div>
  );
}
