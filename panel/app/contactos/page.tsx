"use client";

import { useCallback, useEffect, useState } from "react";
import { Cabecera } from "../componentes";
import { clienteNavegador } from "@/lib/supabase/navegador";

type Encargo = {
  id: number; contacto_id: number; etiqueta: string;
  temas: string[]; secciones: string[]; activo: boolean;
};
type Contacto = {
  id: number; nombre: string; telegram_id: number | null;
  notas: string | null; activo: boolean; encargos: Encargo[];
};
type Calibre = { total: number; promedio_por_edicion: number };

const SECCIONES = [
  ["1", "Legislación"], ["2", "Judiciales"], ["3", "Sociedades"],
  ["4", "Licitaciones"], ["5", "Varios"],
];

// Un tema que pega 14 veces por edición no filtra nada: le manda al
// cliente media Sección 4. Uno que no pega nunca es letra muerta. Esto
// hay que verlo al cargarlo, no cuando el cliente recibe el mensaje.
function veredicto(p: number, total: number) {
  if (p > 8) return { txt: "demasiado amplio", clase: "mal" };
  if (p >= 0.3) return { txt: "bien", clase: "ok" };
  if (total > 0) return { txt: "específico", clase: "" };
  return { txt: "no pega nunca", clase: "mal" };
}

export default function Contactos() {
  const supabase = clienteNavegador();
  const [contactos, setContactos] = useState<Contacto[]>([]);
  const [error, setError] = useState("");
  const [nuevo, setNuevo] = useState(false);
  const [editando, setEditando] = useState<number | null>(null);

  const cargar = useCallback(async () => {
    const { data, error } = await supabase
      .from("contactos")
      .select("id,nombre,telegram_id,notas,activo,encargos(*)")
      .order("nombre");
    if (error) setError(error.message);
    setContactos((data as unknown as Contacto[]) ?? []);
  }, [supabase]);

  useEffect(() => { cargar(); }, [cargar]);

  async function guardarContacto(e: React.FormEvent<HTMLFormElement>, id?: number) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const tg = String(f.get("telegram_id") || "").trim();
    const fila = {
      nombre: String(f.get("nombre") || "").trim(),
      telegram_id: tg ? Number(tg) : null,
      notas: String(f.get("notas") || "").trim() || null,
    };
    const r = id
      ? await supabase.from("contactos").update(fila).eq("id", id)
      : await supabase.from("contactos").insert(fila);
    if (r.error) { setError(r.error.message); return; }
    setNuevo(false); setEditando(null); cargar();
  }

  async function borrarContacto(id: number, nombre: string) {
    if (!confirm(`¿Borrar a ${nombre}? Se van también sus encargos.`)) return;
    const { error } = await supabase.from("contactos").delete().eq("id", id);
    if (error) setError(error.message); else cargar();
  }

  return (
    <div className="marco">
      <Cabecera activa="/contactos" />

      <section style={{ marginTop: 28 }}>
        <div className="fila-titulo">
          <h2>Contactos</h2>
          <button className="btn" onClick={() => { setNuevo(!nuevo); setEditando(null); }}>
            {nuevo ? "Cancelar" : "+ Nuevo contacto"}
          </button>
        </div>
        <p className="nota">
          Reciben por Telegram el resumen de sus temas. No tienen acceso a este panel.
        </p>
        {error && <p className="error">{error}</p>}

        {nuevo && (
          <form className="tarjeta-form" onSubmit={(e) => guardarContacto(e)}>
            <FormularioContacto />
          </form>
        )}

        {contactos.length === 0 && !nuevo && (
          <p className="nota" style={{ marginTop: 20 }}>
            Todavía no hay contactos. El primero se carga con el botón de arriba.
          </p>
        )}

        {contactos.map((c) => (
          <div key={c.id} className="ficha">
            {editando === c.id ? (
              <form className="tarjeta-form" onSubmit={(e) => guardarContacto(e, c.id)}>
                <FormularioContacto c={c} />
                <button type="button" className="btn" style={{ marginLeft: 8 }}
                        onClick={() => setEditando(null)}>Cancelar</button>
              </form>
            ) : (
              <>
                <div className="ficha-cab">
                  <div>
                    <h3 className="ficha-nombre">{c.nombre}</h3>
                    <p className="nota" style={{ marginTop: 2 }}>
                      {c.telegram_id
                        ? <>Telegram <code>{c.telegram_id}</code></>
                        : <span className="sin-tg">sin Telegram — todavía no puede recibir</span>}
                      {c.notas ? ` · ${c.notas}` : ""}
                    </p>
                  </div>
                  <span className="acciones">
                    <button className="btn mini" onClick={() => { setEditando(c.id); setNuevo(false); }}>Editar</button>
                    <button className="btn mini" onClick={() => borrarContacto(c.id, c.nombre)}>Borrar</button>
                  </span>
                </div>
                <Encargos contacto={c} alCambiar={cargar} />
              </>
            )}
          </div>
        ))}
      </section>
      <div style={{ height: 60 }} />
    </div>
  );
}

function FormularioContacto({ c }: { c?: Contacto }) {
  return (
    <>
      <div className="campos">
        <label>Nombre
          <input name="nombre" required defaultValue={c?.nombre ?? ""} placeholder="Nombre y apellido" />
        </label>
        <label>ID de Telegram
          <input name="telegram_id" inputMode="numeric" defaultValue={c?.telegram_id ?? ""}
                 placeholder="se completa cuando le escriba al bot" />
        </label>
        <label>Notas
          <input name="notas" defaultValue={c?.notas ?? ""} placeholder="quién es, qué le interesa" />
        </label>
      </div>
      <button className="btn sello" type="submit">Guardar</button>
    </>
  );
}

function Encargos({ contacto, alCambiar }: { contacto: Contacto; alCambiar: () => void }) {
  const supabase = clienteNavegador();
  const [nuevo, setNuevo] = useState(false);
  const [temas, setTemas] = useState<string[]>([]);
  const [tema, setTema] = useState("");
  const [secciones, setSecciones] = useState<string[]>(["1", "4"]);
  const [calibres, setCalibres] = useState<Record<string, Calibre>>({});

  async function calibrar(t: string, secs: string[]) {
    const { data } = await supabase.rpc("calibrar_tema", { p_tema: t, p_secciones: secs });
    const c = Array.isArray(data) ? data[0] : data;
    if (c) setCalibres((prev) => ({ ...prev, [t]: c as Calibre }));
  }

  function agregarTema() {
    const t = tema.trim().toLowerCase();
    if (!t || temas.includes(t)) return;
    setTemas([...temas, t]); setTema(""); calibrar(t, secciones);
  }

  async function guardar(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const { error } = await supabase.from("encargos").insert({
      contacto_id: contacto.id,
      etiqueta: String(f.get("etiqueta") || "").trim(),
      temas, secciones,
    });
    if (!error) { setNuevo(false); setTemas([]); setCalibres({}); alCambiar(); }
  }

  async function borrar(id: number) {
    await supabase.from("encargos").delete().eq("id", id);
    alCambiar();
  }

  return (
    <div className="encargos">
      {contacto.encargos?.map((e) => (
        <div key={e.id} className="encargo">
          <span>
            <b>{e.etiqueta}</b>
            <span className="f-num"> · secciones {e.secciones.join(", ")}</span>
            <br />
            {e.temas.map((t) => <span key={t} className="chip tema">{t}</span>)}
          </span>
          <button className="btn mini" onClick={() => borrar(e.id)}>Quitar</button>
        </div>
      ))}

      {nuevo ? (
        <form className="tarjeta-form" onSubmit={guardar}>
          <div className="campos">
            <label>Nombre del encargo
              <input name="etiqueta" required placeholder="ej.: Salud y obra vial" />
            </label>
          </div>

          <p className="rotulo" style={{ marginTop: 14 }}>Secciones a mirar</p>
          <div className="secciones">
            {SECCIONES.map(([n, nombre]) => (
              <label key={n} className="check">
                <input type="checkbox" checked={secciones.includes(n)}
                  onChange={(ev) => {
                    const s = ev.target.checked
                      ? [...secciones, n].sort()
                      : secciones.filter((x) => x !== n);
                    setSecciones(s);
                    temas.forEach((t) => calibrar(t, s));
                  }} />
                {n} · {nombre}
              </label>
            ))}
          </div>

          <p className="rotulo" style={{ marginTop: 14 }}>Temas a vigilar</p>
          <div className="busca-fila">
            <input value={tema} onChange={(e) => setTema(e.target.value)}
              placeholder="ej.: apross, obra vial, emergencia hidrica"
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); agregarTema(); } }} />
            <button type="button" className="btn" onClick={agregarTema}>Agregar</button>
          </div>

          {temas.map((t) => {
            const c = calibres[t];
            const v = c ? veredicto(Number(c.promedio_por_edicion), c.total) : null;
            return (
              <div key={t} className="tema-fila">
                <span className="chip tema">{t}</span>
                {c ? (
                  <span className={`calibre ${v!.clase}`}>
                    {c.total} normas en el archivo · {c.promedio_por_edicion} por edición
                    <b> — {v!.txt}</b>
                  </span>
                ) : <span className="calibre">midiendo…</span>}
                <button type="button" className="btn mini"
                        onClick={() => setTemas(temas.filter((x) => x !== t))}>×</button>
              </div>
            );
          })}

          <p className="nota" style={{ marginTop: 10 }}>
            El número que importa es el de por edición: uno o dos por día es un tema
            útil; catorce le manda al cliente media sección.
          </p>
          <div style={{ marginTop: 12 }}>
            <button className="btn sello" type="submit" disabled={!temas.length}>Guardar encargo</button>
            <button type="button" className="btn" style={{ marginLeft: 8 }}
                    onClick={() => setNuevo(false)}>Cancelar</button>
          </div>
        </form>
      ) : contacto.encargos?.length ? (
        <button className="btn mini" onClick={() => setNuevo(true)}>+ Agregar encargo</button>
      ) : (
        <div className="vacio-guia chico">
          <p className="nota">
            Sin encargos, este contacto no recibe nada. El encargo es lo que dice
            qué temas vigilarle.
          </p>
          <button className="btn sello" style={{ marginTop: 10 }}
                  onClick={() => setNuevo(true)}>+ Crear su primer encargo</button>
        </div>
      )}
    </div>
  );
}
