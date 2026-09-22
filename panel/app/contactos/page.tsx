"use client";

import { useCallback, useEffect, useState } from "react";
import { Cabecera } from "../componentes";
import { clienteNavegador } from "@/lib/supabase/navegador";

type Encargo = {
  id: number; contacto_id: number; etiqueta: string;
  temas: string[]; secciones: string[]; umbral: number; activo: boolean;
};
type Contacto = {
  id: number; nombre: string; telegram_id: number | null;
  notas: string | null; activo: boolean; encargos: Encargo[];
};
type Calibre = {
  total: number; promedio_por_edicion: number;
  evaluadas: number; ediciones: number;
  muestra: { prob: number; fecha: string; titulo: string }[];
};

// El umbral es la perilla ancho/angosto. No se expone como "0.7" porque
// ese número no le dice nada a nadie: se elige por la intención.
const ANCHOS: [number, string, string][] = [
  [0.5, "Ancha",  "todo lo que roce el tema — para campaña"],
  [0.7, "Normal", "lo que trate del tema"],
  [0.85, "Angosta", "solo lo que sea claramente del tema"],
];
type Quien = { id: number; nombre: string; usuario: string | null; texto: string };

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
                    <h3 className="ficha-nombre">
                      {c.nombre}
                      {c.telegram_id
                        ? <span className="chip tema">Telegram activo</span>
                        : <span className="chip mal">sin Telegram</span>}
                    </h3>
                    <p className="nota" style={{ marginTop: 2 }}>
                      {c.notas || (c.telegram_id
                        ? <>Telegram <code>{c.telegram_id}</code></>
                        : "todavía no puede recibir")}
                    </p>
                  </div>
                  <span className="acciones">
                    <Vincular contacto={c} alCambiar={cargar} />
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

// Vincular sin pedirle nada técnico al cliente: él escribe "hola" al bot y
// acá aparece para elegirlo. Pedirle su chat_id sería pedirle que abra una
// URL con un token y busque un número adentro de un JSON.
function Vincular({ contacto, alCambiar }: { contacto: Contacto; alCambiar: () => void }) {
  const supabase = clienteNavegador();
  const [abierto, setAbierto] = useState(false);
  const [quienes, setQuienes] = useState<Quien[] | null>(null);
  const [desvinculando, setDesvinculando] = useState(false);
  const [error, setError] = useState("");

  const buscar = useCallback(async () => {
    setError(""); setQuienes(null);
    const r = await fetch("/api/telegram");
    const c = await r.json();
    if (!r.ok) { setError(c.error ?? "no pude consultar Telegram"); return; }
    setQuienes(c.quienes ?? []);
  }, []);

  async function vincular(q: Quien) {
    const { error } = await supabase.from("contactos")
      .update({ telegram_id: q.id }).eq("id", contacto.id);
    if (error) setError(error.message);
    else { setAbierto(false); alCambiar(); }
  }

  // Vale también para corregir: si al vincular se eligió a la persona
  // equivocada, o si el cliente cambió de cuenta, hay que poder rehacerlo
  // sin borrar el contacto y perder sus encargos.
  if (!abierto) {
    return (
      <button className={`btn mini ${contacto.telegram_id ? "" : "sello"}`}
              onClick={() => { setAbierto(true); buscar(); }}>
        {contacto.telegram_id ? "Cambiar Telegram" : "Vincular Telegram"}
      </button>
    );
  }

  return (
    <div className="vincular">
      <p className="nota">
        Pedile a <b>{contacto.nombre}</b> que le escriba <b>cualquier cosa</b> a{" "}
        <b>@AsesorLegislativoBot</b>. Cuando lo haga, va a aparecer acá.
      </p>
      {contacto.telegram_id && (
        <p className="nota">
          Hoy está vinculado a <code>{contacto.telegram_id}</code>. Elegir otro
          lo reemplaza; los encargos y el historial no se tocan.
        </p>
      )}
      {error && <p className="error">{error}</p>}
      {quienes === null && <p className="nota">Consultando…</p>}
      {quienes?.length === 0 && (
        <p className="nota">
          Nadie nuevo escribió todavía. Telegram descarta los mensajes sin leer
          a las 24 horas, así que tiene que escribir y vincularlo el mismo día.
        </p>
      )}
      {quienes?.map((q) => (
        <div key={q.id} className="quien">
          <span>
            <b>{q.nombre}</b> {q.usuario && <span className="f-num">{q.usuario}</span>}
            <br /><span className="nota">escribió: “{q.texto}”</span>
          </span>
          <button className="btn mini" onClick={() => vincular(q)}>Es este</button>
        </div>
      ))}
      <span className="acciones" style={{ marginTop: 8 }}>
        <button className="btn mini" onClick={buscar}>Actualizar</button>
        {contacto.telegram_id && (
          <button className="btn mini" disabled={desvinculando}
                  onClick={async () => {
                    setDesvinculando(true);
                    await supabase.from("contactos")
                      .update({ telegram_id: null }).eq("id", contacto.id);
                    setDesvinculando(false); setAbierto(false); alCambiar();
                  }}>Desvincular</button>
        )}
        <button className="btn mini" onClick={() => setAbierto(false)}>Cerrar</button>
      </span>
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
                 placeholder="dejalo vacío — se vincula solo" />
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
  // null = nada abierto · 0 = creando uno nuevo · id = editando ese
  const [editando, setEditando] = useState<number | null>(null);
  const [etiqueta, setEtiqueta] = useState("");
  const [temas, setTemas] = useState<string[]>([]);
  const [tema, setTema] = useState("");
  const [secciones, setSecciones] = useState<string[]>(["1", "4"]);
  const [umbral, setUmbral] = useState(0.7);
  const [calibres, setCalibres] = useState<Record<string, Calibre>>({});

  // Calibrar cuesta plata (juzga una muestra real con Jev), así que va por
  // el servidor y no por RPC: la clave nunca baja al navegador.
  const calibrar = useCallback(async (t: string, secs: string[], u: number) => {
    setCalibres((prev) => { const c = { ...prev }; delete c[t]; return c; });
    const r = await fetch("/api/calibrar", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tema: t, secciones: secs, umbral: u }),
    });
    const c = await r.json();
    if (r.ok) setCalibres((prev) => ({ ...prev, [t]: c as Calibre }));
  }, []);

  function abrir(e?: Encargo) {
    setEditando(e?.id ?? 0);
    setEtiqueta(e?.etiqueta ?? "");
    setTemas(e?.temas ?? []);
    setSecciones(e?.secciones ?? ["1", "4"]);
    setUmbral(e?.umbral ?? 0.7);
    setCalibres({});
    setTema("");
    // Al editar NO se recalibra solo: cada calibración es una llamada paga.
    // Se pide a mano, tema por tema.
  }

  // Acepta varios de una: "obras, apross, epec" entra como TRES temas.
  // Escribirlos con comas es lo natural —y era lo que sugería el cartel del
  // campo—, pero guardarlos como un solo tema exige que las tres palabras
  // estén en la misma norma, así que no pegaba nunca.
  function agregarTema() {
    const nuevos = tema.split(",")
      .map((x) => x.trim().toLowerCase())
      .filter((x) => x && !temas.includes(x));
    if (!nuevos.length) return;
    setTemas([...temas, ...nuevos]);
    setTema("");
  }

  async function guardar(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fila = { etiqueta: etiqueta.trim(), temas, secciones, umbral };
    const r = editando
      ? await supabase.from("encargos").update(fila).eq("id", editando)
      : await supabase.from("encargos").insert({ contacto_id: contacto.id, ...fila });
    if (!r.error) { setEditando(null); alCambiar(); }
  }

  async function borrar(id: number) {
    await supabase.from("encargos").delete().eq("id", id);
    alCambiar();
  }

  return (
    <div className="encargos">
      {contacto.encargos?.length ? (
        <p className="rotulo">
          Encargos · {contacto.encargos.length}
        </p>
      ) : null}
      {contacto.encargos?.map((e) => (
        <div key={e.id} className="encargo">
          <span>
            <b>{e.etiqueta}</b>
            <span className="f-num"> · secciones {e.secciones.join(", ")}</span>
            <br />
            {e.temas.map((t) => <span key={t} className="chip tema">{t}</span>)}
          </span>
          <span className="acciones">
            <button className="btn mini" onClick={() => abrir(e)}>Editar</button>
            <button className="btn mini" onClick={() => borrar(e.id)}>Quitar</button>
          </span>
        </div>
      ))}

      {editando !== null ? (
        <form className="tarjeta-form" onSubmit={guardar}>
          <div className="campos">
            <label>Nombre del encargo
              <input required value={etiqueta} onChange={(e) => setEtiqueta(e.target.value)}
                     placeholder="ej.: Salud y obra vial" />
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
                    setCalibres({});   // los números cambian con las secciones
                  }} />
                {n} · {nombre}
              </label>
            ))}
          </div>

          <p className="rotulo" style={{ marginTop: 14 }}>Temas a vigilar</p>
          <div className="busca-fila">
            <input value={tema} onChange={(e) => setTema(e.target.value)}
              placeholder="una palabra o frase — se pueden varias separadas por coma"
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); agregarTema(); } }} />
            <button type="button" className="btn" onClick={agregarTema}>Agregar</button>
          </div>

          {temas.map((t) => {
            const c = calibres[t];
            const v = c ? veredicto(Number(c.promedio_por_edicion), c.total) : null;
            return (
              <div key={t}>
                <div className="tema-fila">
                  <span className="chip tema">{t}</span>
                  {c ? (
                    <span className={`calibre ${v!.clase}`}>
                      {c.total} de {c.evaluadas} en las últimas {c.ediciones} ediciones
                      · {c.promedio_por_edicion} por edición
                      <b> — {v!.txt}</b>
                    </span>
                  ) : (
                    <button type="button" className="btn mini"
                            onClick={() => calibrar(t, secciones, umbral)}>
                      Medir cuánto pega
                    </button>
                  )}
                  <button type="button" className="btn mini"
                          onClick={() => setTemas(temas.filter((x) => x !== t))}>×</button>
                </div>
                {/* El número dice cuántas; los títulos dicen si son las que
                    él esperaba. Sin esto, calibrar es confiar a ciegas. */}
                {c && c.muestra.length > 0 && (
                  <ul className="muestra">
                    {c.muestra.map((m, i) => (
                      <li key={i}>
                        <span className="f-num">{m.prob.toFixed(2)}</span>{" "}
                        <span className="f-num">{m.fecha.slice(5)}</span>{" "}
                        {m.titulo}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}

          <p className="rotulo" style={{ marginTop: 14 }}>Qué tan amplio</p>
          <div className="secciones">
            {ANCHOS.map(([u, nombre, explica]) => (
              <label key={u} className="check">
                <input type="radio" name="umbral" checked={umbral === u}
                       onChange={() => { setUmbral(u); setCalibres({}); }} />
                {nombre} — <span className="f-num">{explica}</span>
              </label>
            ))}
          </div>

          <p className="nota" style={{ marginTop: 10 }}>
            El número que importa es el de por edición: uno o dos por día es un tema
            útil; catorce le manda al cliente media sección.
          </p>
          <p className="nota">
            Los temas se miran por <b>significado</b>, no por palabra: «obra vial»
            alcanza a «Bacheo Zona 4» y a «Pavimento Modular», que no comparten
            ninguna palabra. Se pueden escribir como frase. Alcanza con que pegue
            uno de los temas.
          </p>
          <div style={{ marginTop: 12 }}>
            <button className="btn sello" type="submit" disabled={!temas.length}>
              {editando ? "Guardar cambios" : "Guardar encargo"}
            </button>
            <button type="button" className="btn" style={{ marginLeft: 8 }}
                    onClick={() => setEditando(null)}>Cancelar</button>
          </div>
        </form>
      ) : contacto.encargos?.length ? (
        <button className="btn mini" onClick={() => abrir()}>+ Agregar encargo</button>
      ) : (
        <div className="vacio-guia chico">
          <p className="nota">
            Sin encargos, este contacto no recibe nada. El encargo es lo que dice
            qué temas vigilarle.
          </p>
          <button className="btn sello" style={{ marginTop: 10 }}
                  onClick={() => abrir()}>+ Crear su primer encargo</button>
        </div>
      )}
    </div>
  );
}
