"use client";

import { useCallback, useEffect, useState } from "react";
import { Cabecera } from "../componentes";
import { clienteNavegador } from "@/lib/supabase/navegador";

type Vigilancia = { temas: string[]; min_destacadas: number; max_destacadas: number };
type Medida = { ediciones: number; a_mano: number; promedio: number };

// Medido el 22/09/2026: destacar una norma en el despacho diario sale 0,36 ¢
// y resumirla a pedido 0,61 ¢, porque el pedido a mano tiene que volver a
// mandar el texto de la página. Destacar las 14 que no venían destacadas
// costaba 5,0 ¢, así que 5,0/0,61 = 8,2 normas es el punto donde conviene
// subir el rango en vez de seguir clickeando.
const EQUILIBRIO = 8;

export default function Vigilancia() {
  const supabase = clienteNavegador();
  const [v, setV] = useState<Vigilancia | null>(null);
  const [tema, setTema] = useState("");
  const [medida, setMedida] = useState<Medida | null>(null);
  const [guardado, setGuardado] = useState(false);
  const [error, setError] = useState("");

  const cargar = useCallback(async () => {
    const { data, error } = await supabase.from("vigilancia")
      .select("temas,min_destacadas,max_destacadas").eq("id", 1).single();
    if (error) setError(error.message);
    else setV(data as Vigilancia);
    const { data: m } = await supabase.rpc("resumidas_a_mano", { p_ediciones: 10 });
    setMedida(Array.isArray(m) ? (m[0] as Medida) : (m as Medida));
  }, [supabase]);

  useEffect(() => { cargar(); }, [cargar]);

  async function guardar() {
    if (!v) return;
    setError(""); setGuardado(false);
    const { error } = await supabase.from("vigilancia")
      .update({ ...v, actualizado_en: new Date().toISOString() }).eq("id", 1);
    if (error) setError(error.message);
    else { setGuardado(true); setTimeout(() => setGuardado(false), 3000); }
  }

  function agregar() {
    const t = tema.trim();
    if (!t || !v || v.temas.includes(t)) return;
    setV({ ...v, temas: [...v.temas, t] });
    setTema("");
  }

  if (!v) {
    return (
      <div className="marco">
        <Cabecera activa="/vigilancia" />
        <p className="nota" style={{ marginTop: 28 }}>
          {error || "Cargando…"}
        </p>
      </div>
    );
  }

  const conviene = medida && Number(medida.promedio) > EQUILIBRIO;

  return (
    <div className="marco">
      <Cabecera activa="/vigilancia" />

      <section style={{ marginTop: 28 }}>
        <div className="fila-titulo">
          <h2>Tus temas vigilados</h2>
        </div>
        <p className="nota">
          Esto decide qué normas <b>analiza el motor</b> cada mañana, de las ~45
          que trae una edición. Es tu criterio editorial, no el de nadie más:
          los temas de tus clientes son otra lista y viven en Contactos.
        </p>

        <p className="rotulo" style={{ marginTop: 18 }}>Temas</p>
        <div className="busca-fila">
          <input value={tema} onChange={(e) => setTema(e.target.value)}
                 placeholder="ej.: Régimen de promoción industrial"
                 onKeyDown={(e) => {
                   if (e.key === "Enter") { e.preventDefault(); agregar(); }
                 }} />
          <button type="button" className="btn" onClick={agregar}>Agregar</button>
        </div>

        {v.temas.map((t) => (
          <div key={t} className="tema-fila">
            <span className="chip tema">{t}</span>
            <button type="button" className="btn mini"
                    onClick={() => setV({ ...v, temas: v.temas.filter((x) => x !== t) })}>
              ×
            </button>
          </div>
        ))}
        {!v.temas.length && (
          <p className="nota">
            Sin temas, el motor destaca solo por alcance general e impacto
            fiscal. Funciona, pero pierde lo que a vos te importa.
          </p>
        )}

        <p className="rotulo" style={{ marginTop: 22 }}>Cuántas destacar por día</p>
        <div className="busca-fila">
          <input type="number" min={1} max={40} value={v.min_destacadas}
                 aria-label="Mínimo"
                 onChange={(e) => setV({ ...v, min_destacadas: Number(e.target.value) })} />
          <span className="nota">a</span>
          <input type="number" min={1} max={40} value={v.max_destacadas}
                 aria-label="Máximo"
                 onChange={(e) => setV({ ...v, max_destacadas: Number(e.target.value) })} />
        </div>

        {/* El aviso que reemplaza tener que deducirlo a mano cada tanto. */}
        {medida && medida.a_mano > 0 && (
          <p className={`nota ${conviene ? "" : ""}`} style={{ marginTop: 10 }}>
            En las últimas {medida.ediciones} ediciones resumiste a pedido{" "}
            <b>{medida.a_mano}</b> normas · {medida.promedio} por edición.{" "}
            {conviene ? (
              <span className="calibre mal">
                Pasa de {EQUILIBRIO}: te conviene subir el máximo. Que las
                destaque el motor sale 0,36 ¢ y resumirlas a mano 0,61 ¢.
              </span>
            ) : (
              <span className="calibre ok">
                Por debajo de {EQUILIBRIO}, así que conviene dejarlo: subir el
                rango pagaría análisis que nadie va a leer.
              </span>
            )}
          </p>
        )}

        <p className="nota" style={{ marginTop: 10 }}>
          El motor los trae de acá cada vez que corre. Si Supabase no contesta
          usa la lista de <code>instrucciones.md</code> y lo avisa por pantalla,
          así que una caída no le cambia el criterio.
        </p>

        <div style={{ marginTop: 16 }}>
          <button className="btn sello" onClick={guardar}>Guardar</button>
          {guardado && <span className="calibre ok" style={{ marginLeft: 10 }}>
            guardado · se aplica en la próxima corrida</span>}
          {error && <span className="calibre mal" style={{ marginLeft: 10 }}>{error}</span>}
        </div>
      </section>
    </div>
  );
}
