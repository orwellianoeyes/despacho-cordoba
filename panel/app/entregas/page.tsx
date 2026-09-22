"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Cabecera } from "../componentes";
import { clienteNavegador } from "@/lib/supabase/navegador";

type Pendiente = {
  encargo_id: number; etiqueta: string; temas: string[];
  contacto_id: number; contacto: string; telegram_id: number | null;
  cuantas: number; ya_entregada: boolean;
  emparejado: boolean; evaluadas: number;
};
type Norma = {
  id: number; tipo: string; numero: string; titulo: string;
  seccion: string; pagina: number; url_oficial: string | null;
  destacada: boolean; importa: string | null;
  ampliada: Record<string, string> | null;
  extenso: string | null;
  temas_que_pegaron: string[];
  prob: number;
};
type Formato = "titulares" | "breve" | "completo" | "extenso";
type Enviada = {
  id: number; fecha: string; enviada_en: string; texto: string;
  contactos: { nombre: string } | null;
};

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
  const [analizando, setAnalizando] = useState<string | null>(null);
  const [historial, setHistorial] = useState<Enviada[] | null>(null);
  const [verTexto, setVerTexto] = useState<number | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [emparejando, setEmparejando] = useState(false);
  const [duplicadas, setDuplicadas] = useState<Set<number>>(new Set());
  const [sinProcesar, setSinProcesar] = useState<Set<string>>(new Set());
  const [corrida, setCorrida] = useState<{ estado: string; detalle: string | null } | null>(null);

  // Los días hábiles recientes que TODAVÍA no tienen despacho, para poder
  // elegirlos. Sin esto el selector solo ofrecía ediciones ya procesadas y
  // los botones de correr quedaban sin sentido: preguntaban "¿falta
  // procesar esta edición?" sobre ediciones que por definición no faltaban.
  function habilesRecientes(cuantos: number): string[] {
    const dias: string[] = [];
    const d = new Date();
    while (dias.length < cuantos) {
      const finde = d.getDay() === 0 || d.getDay() === 6;
      if (!finde) {
        dias.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
                  + `-${String(d.getDate()).padStart(2, "0")}`);
      }
      d.setDate(d.getDate() - 1);
    }
    return dias;
  }

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("despachos").select("fecha")
        .order("fecha", { ascending: false }).limit(60);
      const hechas = (data ?? []).map((d: { fecha: string }) => d.fecha);
      const faltan = habilesRecientes(6).filter((f) => !hechas.includes(f));
      setSinProcesar(new Set(faltan));
      const todas = [...faltan, ...hechas].sort().reverse();
      setFechas(todas);
      // Se abre en la última YA procesada: es lo que se mira a la mañana.
      // Las que faltan están ahí arriba para ir a buscarlas a propósito.
      if (hechas.length) setFecha(hechas[0]);
      else if (todas.length) setFecha(todas[0]);
    })();
  }, [supabase]);

  const cargar = useCallback(async () => {
    if (!fecha) return;
    setError(""); setAbierto(null); setPrevia(null);
    const { data, error } = await supabase.rpc("pendientes_del_dia", { p_fecha: fecha });
    if (error) setError(error.message);
    const ps = (data as Pendiente[]) ?? [];
    setPendientes(ps);

    // Emparejar lo que falte. Se dispara solo porque el panorama de la
    // mañana sin esto no dice nada: "0 normas" y "todavía no miré" se ven
    // igual. Cuesta fracciones de centavo y queda guardado, así que volver
    // a abrir el panel no vuelve a gastar.
    if (ps.some((p) => !p.emparejado)) {
      setEmparejando(true);
      try {
        const r = await fetch("/api/emparejar", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fecha }),
        });
        const c = await r.json();
        if (!r.ok) throw new Error(c.error || "no se pudo emparejar");
        const { data: d2 } = await supabase.rpc("pendientes_del_dia", { p_fecha: fecha });
        setPendientes((d2 as Pendiente[]) ?? ps);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally { setEmparejando(false); }
    }
  }, [fecha, supabase]);

  useEffect(() => { cargar(); }, [cargar]);

  // El buzón: el panel deja el pedido y la Mac lo levanta. La nube no puede
  // darle una orden a la Mac (el Boletín bloquea a las IP de datacenter, así
  // que la descarga sale de casa), por eso se da vuelta la dirección.
  const mirarCorrida = useCallback(async () => {
    const { data } = await supabase.from("corridas")
      .select("estado,detalle").order("pedida_en", { ascending: false }).limit(1);
    const c = data?.[0];
    if (c) setCorrida(c as { estado: string; detalle: string | null });
    if (c && (c.estado === "lista" || c.estado === "fallida")) { cargar(); return true; }
    return false;
  }, [supabase, cargar]);

  async function pedirCorrida(sinIa: boolean) {
    setOcupado(true); setError(""); setAviso("");
    const { error } = await supabase.from("corridas").insert({
      fecha, secciones: ["1", "4"], motor: "claude", sin_ia: sinIa, rehacer: true,
    });
    setOcupado(false);
    if (error) { setError(error.message); return; }
    setCorrida({ estado: "pendiente", detalle: null });
    // La Mac consulta cada minuto; se mira hasta que termine.
    const reloj = setInterval(async () => {
      if (await mirarCorrida()) clearInterval(reloj);
    }, 8000);
    setTimeout(() => clearInterval(reloj), 20 * 60 * 1000);
  }

  async function reemparejar(encargo_id: number) {
    setEmparejando(true); setError(""); setAviso("");
    try {
      const r = await fetch("/api/emparejar", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fecha, encargo_id, rehacer: true }),
      });
      const c = await r.json();
      if (!r.ok) throw new Error(c.error || "no se pudo emparejar");
      const h = c.hechos?.[0];
      if (h) setAviso(`${h.coinciden} de ${h.evaluadas} · ${(h.costo * 100).toFixed(2)} ¢`);
      const { data } = await supabase.rpc("pendientes_del_dia", { p_fecha: fecha });
      setPendientes((data as Pendiente[]) ?? []);
      setAbierto(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setEmparejando(false); }
  }

  // El despacho trae DOS listas —las destacadas con análisis y el índice
  // completo— y la función que las une acierta el 95%. En el 5% restante el
  // motor escribió el título de dos formas y queda la misma norma dos
  // veces: "Bacheo Zona 4 - Etapa II" y "Bacheo Zona 4 - Etapa II (ACIF)",
  // mismo expediente y misma página. Son 34 pares en el archivo.
  //
  // No se borra ninguna: se destilda la copia sin análisis. Si la regla
  // acierta, el mensaje sale limpio sin hacer nada; si alguna vez se
  // equivoca, la fila está a la vista y se vuelve a tildar. Nunca
  // desaparece algo en silencio, que es lo que no se puede arriesgar.
  //
  // La condición es estrecha a propósito: mismo número Y misma página Y
  // exactamente una con análisis. Sin lo de la página, una edición con dos
  // normas distintas numeradas "7" se fusionaría — y eso ya pasó con nueve
  // avisos numerados todos "Digital Capítulo V".
  function repetidas(ns: Norma[]): Set<number> {
    const grupos = new Map<string, Norma[]>();
    for (const n of ns) {
      const k = `${n.seccion}|${n.numero}|${n.pagina}`;
      grupos.set(k, [...(grupos.get(k) ?? []), n]);
    }
    const fuera = new Set<number>();
    for (const g of grupos.values()) {
      if (g.length < 2) continue;
      const conAnalisis = g.filter((n) => n.ampliada);
      if (conAnalisis.length !== 1) continue;
      g.filter((n) => !n.ampliada).forEach((n) => fuera.add(n.id));
    }
    return fuera;
  }

  async function abrir(p: Pendiente) {
    if (abierto === p.encargo_id) { setAbierto(null); return; }
    setAbierto(p.encargo_id); setPrevia(null); setError(""); setFormato("titulares");
    const { data } = await supabase.rpc("normas_del_encargo",
      { p_encargo: p.encargo_id, p_fecha: fecha });
    const ns = (data as Norma[]) ?? [];
    setNormas(ns);
    const dobles = repetidas(ns);
    setDuplicadas(dobles);
    setElegidas(new Set(ns.filter((n) => !dobles.has(n.id)).map((n) => n.id)));
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

  // Generar el análisis acá mismo. Antes había que ir al Buscador, encontrar
  // la norma otra vez y volver — pero cuando el cliente pide "contame más de
  // la segunda", la segunda está justo acá en la pantalla.
  async function analizar(id: number, modo: "corto" | "extenso") {
    setAnalizando(`${id}:${modo}`); setError("");
    try {
      const r = await fetch("/api/resumir", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, modo }),
      });
      const c = await r.json();
      if (!r.ok) throw new Error(c.error || "no se pudo analizar");
      setNormas((prev) => prev.map((n) => n.id !== id ? n : modo === "extenso"
        ? { ...n, extenso: c.extenso }
        : { ...n, ampliada: c.ampliada, importa: c.importa }));
      setPrevia(null);   // el mensaje cambió: hay que volver a verlo
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setAnalizando(null); }
  }

  // Lo enviado se guardaba desde el principio pero no había dónde mirarlo.
  // Importa por dos motivos: saber qué leyó un cliente cuando pregunta, y
  // no mandarle dos veces lo mismo.
  async function verHistorial() {
    if (historial) { setHistorial(null); return; }
    const { data } = await supabase.from("entregas")
      .select("id,fecha,enviada_en,texto,contactos(nombre)")
      .eq("estado", "enviada")
      .order("enviada_en", { ascending: false }).limit(30);
    setHistorial((data as unknown as Enviada[]) ?? []);
  }

  // El problema de cada mañana no es la plata (0,6 ¢ por norma) sino los
  // clics: con cuatro clientes son ~10 normas por día sin analizar. Un botón
  // las resume todas, en fila, mostrando el costo antes.
  async function resumirFaltantes() {
    const faltan = normas.filter((n) => elegidas.has(n.id) && !n.ampliada);
    for (const n of faltan) {
      await analizar(n.id, "corto");
    }
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
            {fechas.map((f) => (
              <option key={f} value={f}>
                {f}{sinProcesar.has(f) ? " · sin procesar" : ""}
              </option>
            ))}
          </select>
        </div>
        <p className="nota">
          El sistema prepara; vos despachás. Nada sale sin que lo hayas visto.
        </p>

        <div className="correr">
          <span className="nota">
            {sinProcesar.has(fecha)
              ? "Esta edición todavía no se bajó. Si el Boletín de ese día ya salió, la Mac la trae."
              : "¿Querés rehacer esta edición?"}
          </span>
          <span className="acciones">
            <button className="btn sello" disabled={ocupado} onClick={() => pedirCorrida(false)}>
              Traer la edición · ~10 ¢
            </button>
            <button className="btn" disabled={ocupado} onClick={() => pedirCorrida(true)}>
              Guardar el texto sin analizar · gratis
            </button>
          </span>
          {corrida && (
            <p className={`nota ${corrida.estado === "fallida" ? "error" : ""}`}>
              {corrida.estado === "pendiente" && "Pedido anotado. La Mac lo levanta en menos de un minuto…"}
              {corrida.estado === "tomada"    && "La Mac lo está procesando. Tarda un par de minutos."}
              {corrida.estado === "lista"     && "Listo: la edición quedó procesada."}
              {corrida.estado === "fallida"   && `Falló: ${corrida.detalle ?? "sin detalle"}`}
            </p>
          )}
          {/* El botón gratis NO trae las normas: archiva el texto crudo y
              nada más. Es el seguro para un día sin crédito, no un modo de
              uso — sin esta aclaración se lee como la opción barata de lo
              mismo, y el panel queda igual que antes de apretarlo. */}
          <p className="nota">
            <b>Traer la edición</b> es la que llena el buscador y Entregas.{" "}
            <b>Guardar el texto</b> no deja nada visible en el panel: baja el
            boletín y lo archiva para poder analizarlo después. Es el seguro
            para un día sin crédito, porque el texto de una edición vieja no
            siempre se puede volver a bajar.
          </p>
          <p className="nota">
            Necesita que la Mac esté escuchando: <code>panel/../escuchar.sh</code>.
            La descarga tiene que salir de una IP hogareña — el Boletín bloquea a la nube.
          </p>
        </div>
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
                  {!p.emparejado
                    ? (emparejando ? "mirando la edición…" : "sin emparejar")
                    : `${p.cuantas} de ${p.evaluadas}`}
                </span>
                {p.ya_entregada && <span className="chip analizada">ya enviada</span>}
                {!p.telegram_id && <span className="chip mal">sin Telegram</span>}
                {/* Si le cambió los temas o el ancho, lo de ayer no sirve.
                    No se recalcula solo para no gastar sin que lo pida. */}
                {p.emparejado && (
                  <button className="btn mini" disabled={emparejando}
                          onClick={() => reemparejar(p.encargo_id)}>
                    Volver a mirar
                  </button>
                )}
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

                {(() => {
                  const faltan = normas.filter((n) => elegidas.has(n.id) && !n.ampliada).length;
                  if (!faltan) return null;
                  return (
                    <p className="nota" style={{ marginTop: 12 }}>
                      {faltan} de las marcadas no tienen análisis — en titulares van
                      sin monto ni fecha.{" "}
                      <button type="button" className="btn mini sello" disabled={!!analizando}
                              onClick={resumirFaltantes}>
                        {analizando ? "resumiendo…" : `Resumir las ${faltan} · ${(faltan * 0.61).toFixed(1)} ¢`}
                      </button>
                    </p>
                  );
                })()}
                <p className="nota" style={{ marginTop: 12 }}>
                  {elegidas.size} de {normas.length} marcadas · destildá lo que no quieras mandar
                  {duplicadas.size > 0 && (
                    <span className="calibre"> · {duplicadas.size}{" "}
                      {duplicadas.size === 1 ? "salió repetida" : "salieron repetidas"}
                      {" "}en la edición y {duplicadas.size === 1 ? "quedó" : "quedaron"}{" "}
                      sin marcar</span>
                  )}
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
                      {/* Cuánto pega. Van ordenadas por esto, no por página:
                          en titulares entran ~15 y el celular lee las tres
                          primeras. */}
                      <span className={`prob ${n.prob >= 0.9 ? "alta" : ""}`}>
                        {n.prob.toFixed(2)}
                      </span>
                      <span className="chip">{n.tipo}</span>
                      {n.temas_que_pegaron.map((t) => (
                        <span key={t} className="chip tema">{t}</span>
                      ))}
                      {duplicadas.has(n.id) &&
                        <span className="chip mal">repetida</span>}
                      {n.extenso && <span className="chip extensa">extenso</span>}
                      <br />
                      {n.titulo} <span className="f-num">· {n.numero}</span>
                      <br />
                      <span className="acciones" style={{ marginTop: 6 }}>
                        {!n.ampliada && (
                          <button type="button" className="btn mini"
                                  disabled={analizando === `${n.id}:corto`}
                                  onClick={(e) => { e.preventDefault(); analizar(n.id, "corto"); }}>
                            {analizando === `${n.id}:corto` ? "…" : "Resumir · 0,6 ¢"}
                          </button>
                        )}
                        {!n.extenso && (
                          <button type="button" className="btn mini sello"
                                  disabled={analizando === `${n.id}:extenso`}
                                  onClick={(e) => { e.preventDefault(); analizar(n.id, "extenso"); }}>
                            {analizando === `${n.id}:extenso` ? "analizando…" : "Extenso · 9 ¢"}
                          </button>
                        )}
                      </span>
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
      <section style={{ marginTop: 34 }}>
        <div className="fila-titulo">
          <h2>Lo que ya mandaste</h2>
          <button className="btn" onClick={verHistorial}>
            {historial ? "Ocultar" : "Ver historial"}
          </button>
        </div>

        {historial?.length === 0 && (
          <p className="nota" style={{ marginTop: 14 }}>
            Todavía no despachaste nada.
          </p>
        )}

        {historial?.map((e) => (
          <div key={e.id} className="ficha">
            <div className="ficha-cab">
              <div>
                <b>{e.contactos?.nombre ?? "—"}</b>
                <p className="nota" style={{ marginTop: 2 }}>
                  edición {e.fecha} · enviado el{" "}
                  {new Date(e.enviada_en).toLocaleString("es-AR",
                    { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  {" · "}{e.texto?.length ?? 0} caracteres
                </p>
              </div>
              <button className="btn mini"
                      onClick={() => setVerTexto(verTexto === e.id ? null : e.id)}>
                {verTexto === e.id ? "Cerrar" : "Ver lo que recibió"}
              </button>
            </div>
            {verTexto === e.id && (
              <div className="panel-analisis texto-crudo" style={{ marginTop: 12 }}>
                <pre className="crudo">{e.texto}</pre>
              </div>
            )}
          </div>
        ))}
      </section>

      <div style={{ height: 60 }} />
    </div>
  );
}
