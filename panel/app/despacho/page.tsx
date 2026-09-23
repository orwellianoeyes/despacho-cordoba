"use client";

import { useCallback, useEffect, useState } from "react";
import { Cabecera } from "../componentes";
import { EnviarSuelta } from "../enviar";
import { clienteNavegador } from "@/lib/supabase/navegador";

// Lo que salió del día, según TU criterio. Es la otra mitad de Entregas:
// allá se ve qué le toca a cada cliente, acá qué eligió el motor con los
// temas vigilados. Antes esto solo existía en la app pública, y para ver
// una destacada había que ir a buscarla al Buscador sabiendo el título.

type Despacho = {
  fecha: string; numero_boletin: string; motor: string;
  sintesis_juridica: string[]; sintesis_politica: string[];
  hora_procesado: string | null;
};
type Norma = {
  id: number; fecha: string; tipo: string; numero: string; titulo: string;
  seccion: string; pagina: number; url_oficial: string | null;
  importa: string | null;
  ampliada: Record<string, string> | null;
  extenso: string | null;
};
type Movimiento = {
  id: number; tipo: string; instrumento: string; titulo: string;
  detalle: string | null; organismo: string | null; pagina: number;
};

const MIRADAS: [string, string, string][] = [
  ["juridica", "Lo jurídico", "j"],
  ["politica", "Lo político", "p"],
  ["oficialista", "Mirada oficialista", "o"],
  ["opositora", "Mirada opositora", "c"],
];

export default function DespachoDelDia() {
  const supabase = clienteNavegador();
  const [fechas, setFechas] = useState<string[]>([]);
  const [fecha, setFecha] = useState("");
  const [d, setD] = useState<Despacho | null>(null);
  const [normas, setNormas] = useState<Norma[]>([]);
  const [movimientos, setMovimientos] = useState<Movimiento[]>([]);
  const [abierta, setAbierta] = useState<number | null>(null);
  const [enviando, setEnviando] = useState<number | null>(null);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("despachos").select("fecha")
        .order("fecha", { ascending: false }).limit(60);
      const f = (data ?? []).map((x: { fecha: string }) => x.fecha);
      setFechas(f);
      if (f.length) setFecha(f[0]);
      else setCargando(false);
    })();
  }, [supabase]);

  const cargar = useCallback(async () => {
    if (!fecha) return;
    setCargando(true); setAbierta(null); setEnviando(null);
    const [{ data: des }, { data: ns }, { data: ms }] = await Promise.all([
      supabase.from("despachos")
        .select("fecha,numero_boletin,motor,sintesis_juridica,sintesis_politica,hora_procesado")
        .eq("fecha", fecha).single(),
      supabase.from("normas")
        .select("id,fecha,tipo,numero,titulo,seccion,pagina,url_oficial,importa,ampliada,extenso")
        .eq("fecha", fecha).eq("destacada", true).order("seccion").order("pagina"),
      supabase.from("movimientos")
        .select("id,tipo,instrumento,titulo,detalle,organismo,pagina")
        .eq("fecha", fecha).order("pagina"),
    ]);
    setD(des as Despacho | null);
    setNormas((ns as Norma[]) ?? []);
    setMovimientos((ms as Movimiento[]) ?? []);
    setCargando(false);
  }, [fecha, supabase]);

  useEffect(() => { cargar(); }, [cargar]);

  const dia = fecha
    ? new Date(fecha + "T12:00:00-03:00").toLocaleDateString("es-AR",
        { weekday: "long", day: "numeric", month: "long" })
    : "";

  return (
    <div className="marco">
      <Cabecera activa="/despacho" />

      <section style={{ marginTop: 28 }}>
        <div className="fila-titulo">
          <h2>Lo que salió</h2>
          <select value={fecha} onChange={(e) => setFecha(e.target.value)}
                  aria-label="Edición">
            {fechas.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>

        {cargando && <p className="nota">Cargando…</p>}
        {!cargando && !fechas.length && (
          <p className="nota">
            Todavía no hay ninguna edición procesada. Se traen desde Entregas.
          </p>
        )}

        {d && (
          <>
            <p className="nota">
              {dia} · Boletín N° {d.numero_boletin} · {normas.length}{" "}
              {normas.length === 1 ? "destacada" : "destacadas"}
              {d.hora_procesado ? ` · procesado ${d.hora_procesado}` : ""}
              {d.motor !== "claude" && (
                <span className="calibre mal"> · escrito por {d.motor}</span>
              )}
            </p>
            <p className="nota">
              Estas las eligió el motor con <b>tus temas vigilados</b>, no con
              los de tus clientes. Para ver qué le toca a cada uno, Entregas.
            </p>

            {(d.sintesis_juridica?.length > 0 || d.sintesis_politica?.length > 0) && (
              <div className="miradas" style={{ marginTop: 18 }}>
                {d.sintesis_juridica?.length > 0 && (
                  <div className="mirada">
                    <p className="mirada-rotulo m-j">Síntesis jurídica</p>
                    {d.sintesis_juridica.map((p, i) => (
                      <p key={i} className="amp">{p}</p>
                    ))}
                  </div>
                )}
                {d.sintesis_politica?.length > 0 && (
                  <div className="mirada">
                    <p className="mirada-rotulo m-p">Síntesis política</p>
                    {d.sintesis_politica.map((p, i) => (
                      <p key={i} className="amp">{p}</p>
                    ))}
                  </div>
                )}
              </div>
            )}

            {movimientos.length > 0 && (
              <>
                <div className="linea-estado">
                  <span>Designaciones, renuncias y cambios de organismos</span>
                  <span>{movimientos.length}</span>
                </div>
                {movimientos.map((m) => (
                  <div key={m.id} className="movimiento">
                    <span className="chip">{m.tipo}</span>
                    <div>
                      <b>{m.titulo}</b>
                      {m.organismo && <span className="f-num"> · {m.organismo}</span>}
                      {m.detalle && <p className="amp">{m.detalle}</p>}
                      <p className="nota">{m.instrumento}</p>
                    </div>
                  </div>
                ))}
              </>
            )}

            <div className="linea-estado">
              <span>Normas destacadas</span>
              <span>página del PDF a la derecha</span>
            </div>

            {normas.map((n) => (
              <div key={n.id}>
                <div className="resultado">
                  <span className="f-fecha">
                    secc. {n.seccion}<br />pág. {n.pagina}
                  </span>
                  <span>
                    <span className="chip">{n.tipo}</span>
                    {n.extenso && <span className="chip extensa">extenso</span>}
                    <br />
                    {n.titulo}
                    {n.numero && <span className="f-num"> · {n.numero}</span>}
                    {n.importa && <p className="amp">{n.importa}</p>}
                  </span>
                  <span className="acciones">
                    {n.ampliada && (
                      <button className="btn"
                              onClick={() => setAbierta(abierta === n.id ? null : n.id)}>
                        {abierta === n.id ? "Cerrar" : "Las cuatro miradas"}
                      </button>
                    )}
                    {n.url_oficial && (
                      <a className="btn" href={`${n.url_oficial}#page=${n.pagina}`}
                         target="_blank" rel="noopener">PDF ↗</a>
                    )}
                    <button className="btn"
                            onClick={() => setEnviando(enviando === n.id ? null : n.id)}>
                      Enviar a…
                    </button>
                  </span>
                </div>

                {abierta === n.id && n.ampliada && (
                  <div className="panel-analisis">
                    <div className="miradas">
                      {MIRADAS.filter(([k]) => n.ampliada?.[k]).map(([k, rotulo, c]) => (
                        <div key={k} className="mirada">
                          <p className={`mirada-rotulo m-${c}`}>{rotulo}</p>
                          <p className="amp">{n.ampliada![k]}</p>
                        </div>
                      ))}
                    </div>
                    <p className="aviso-ia">
                      Análisis asistido por IA sobre el texto oficial. Contrastar
                      con el Boletín antes de citarlo.
                    </p>
                  </div>
                )}

                {enviando === n.id && (
                  <EnviarSuelta norma={n} alCerrar={() => setEnviando(null)} />
                )}
              </div>
            ))}

            {!normas.length && (
              <p className="nota">
                Esta edición no tiene destacadas. Puede ser un boletín chico, o
                que ninguna norma haya entrado en tus criterios.
              </p>
            )}
          </>
        )}
      </section>
      <div style={{ height: 60 }} />
    </div>
  );
}
