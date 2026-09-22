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

        {/* Dos columnas: los temas a la izquierda, que es la lista que se
            edita, y a la derecha lo que hay que mirar para decidir si está
            bien — el rango y la calibración económica. Apilado obligaba a
            bajar hasta el final para ver el número que justifica el rango. */}
        <div className="vigilancia">
        <div>
        <p className="rotulo">
          Temas <span className="f-num">· {v.temas.length} activos</span>
        </p>
        <div className="busca-fila">
          <input value={tema} onChange={(e) => setTema(e.target.value)}
                 placeholder="ej.: Régimen de promoción industrial"
                 onKeyDown={(e) => {
                   if (e.key === "Enter") { e.preventDefault(); agregar(); }
                 }} />
          <button type="button" className="btn" onClick={agregar}>Agregar</button>
        </div>

        {/* Un registro cerrado y numerado. Sueltos no se leían como lo que
            son: una lista finita de entre tres y diez renglones que decide
            el análisis del día. */}
        <div className="temas-caja">
          <div className="temas-cab">
            <span>Términos bajo vigilancia</span>
            <span>{v.temas.length} {v.temas.length === 1 ? "activo" : "activos"}</span>
          </div>
          {v.temas.map((t, i) => (
            <div key={t} className="tema-reng">
              <span className="tema-orden">{String(i + 1).padStart(2, "0")}</span>
              <span className="tema-texto">{t}</span>
              <button type="button" className="btn mini" aria-label={`Quitar ${t}`}
                      onClick={() => setV({ ...v, temas: v.temas.filter((x) => x !== t) })}>
                ×
              </button>
            </div>
          ))}
          {!v.temas.length && (
            <p className="temas-pie">
              Sin temas, el motor destaca solo por alcance general e impacto
              fiscal. Funciona, pero pierde lo que a vos te importa.
            </p>
          )}
          {v.temas.length > 0 && (
            <p className="temas-pie">
              Las normas que coincidan se analizan enteras en la corrida
              de la mañana, sin costo extra por pedirlas después.
            </p>
          )}
        </div>

        </div>
        <div>
        <p className="rotulo">Cuántas destacar por día</p>
        <div className="busca-fila">
          <input type="number" min={1} max={40} value={v.min_destacadas}
                 aria-label="Mínimo"
                 onChange={(e) => setV({ ...v, min_destacadas: Number(e.target.value) })} />
          <span className="nota">a</span>
          <input type="number" min={1} max={40} value={v.max_destacadas}
                 aria-label="Máximo"
                 onChange={(e) => setV({ ...v, max_destacadas: Number(e.target.value) })} />
        </div>

        {/* El número solo no dice nada: lo que decide son los dos precios y
            dónde se cruzan. Por eso va como tabla y no como frase. */}
        {medida && (
          <div className="calibracion">
            <p className="rotulo">Calibración</p>
            <p className="nota" style={{ marginTop: 6 }}>
              En las últimas {medida.ediciones} ediciones resumiste a pedido{" "}
              <b>{medida.a_mano}</b> normas · {medida.promedio} por edición.
            </p>
            <div className="precios">
              <div><span>Que la destaque el motor</span><b>0,36 ¢</b></div>
              <div><span>Resumirla a mano después</span><b>0,61 ¢</b></div>
              <div className="equilibrio">
                <span>Punto de equilibrio</span><b>{EQUILIBRIO} por edición</b>
              </div>
            </div>
            <p className={`calibre ${conviene ? "mal" : "ok"}`} style={{ marginTop: 8 }}>
              {conviene
                ? "Pasa del equilibrio: conviene subir el máximo."
                : "Por debajo del equilibrio: subir el rango pagaría análisis que nadie va a leer."}
            </p>
          </div>
        )}

        <p className="nota" style={{ marginTop: 10 }}>
          El motor los trae de acá cada vez que corre. Si Supabase no contesta
          usa la lista de <code>instrucciones.md</code> y lo avisa por pantalla,
          así que una caída no le cambia el criterio.
        </p>

        </div>
        </div>

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
