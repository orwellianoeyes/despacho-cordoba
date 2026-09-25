"use client";

import { useEffect, useState } from "react";
import { clienteNavegador } from "@/lib/supabase/navegador";

// Lo único que hace falta saber de la norma para mandarla. Se deja chico a
// propósito: lo usan el Buscador y el Despacho del día, que traen la norma
// con formas distintas.
export type Aviso = { id: number; fecha: string };

// Mandar UNA norma a alguien, fuera de su encargo. El caso real: el
// cliente escribe "¿qué pasó con la ruta 9?" y eso no está entre sus
// temas, así que no aparece en Entregas.
//
// Reusa /api/entregar por el camino `contacto_id`, con lo cual hereda lo
// que importa: la vista previa se edita, el tope de Telegram se controla,
// y queda en la bitácora con el texto que realmente salió.
export function EnviarSuelta({ norma, alCerrar }:
                             { norma: Aviso; alCerrar: () => void }) {
  const supabase = clienteNavegador();
  const [gente, setGente] = useState<{ id: number; nombre: string }[]>([]);
  const [quien, setQuien] = useState<number | null>(null);
  const [formato, setFormato] = useState("completo");
  const [previa, setPrevia] = useState<{ texto: string; tope: number } | null>(null);
  const [borrador, setBorrador] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState("");
  const [error, setError] = useState("");
  const [copiado, setCopiado] = useState(false);

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

  // El extenso pesa ~9000 caracteres y Telegram corta en 4096: por diseño
  // no entra, no es un caso raro. Antes el botón quedaba gris y ahí moría
  // el asunto. Ahora el texto se copia entero y sale por donde sea —
  // WhatsApp, mail, un documento— sin pasar por el bot.
  async function copiar() {
    try {
      await navigator.clipboard.writeText(borrador);
      setCopiado(true); setError("");
      setTimeout(() => setCopiado(false), 2500);
    } catch {
      setError("El navegador no dejó copiar. Seleccioná el texto del cuadro "
             + "y copialo con Cmd+C.");
    }
  }

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
              {borrador.length > previa.tope && (
                <p className="nota">
                  Telegram no acepta mensajes de más de {previa.tope} caracteres,
                  así que este no sale por el bot. <b>Copialo</b> y mandalo por
                  donde quieras, o recortalo acá hasta que entre.
                </p>
              )}
            </>
          )}

          <div className="acciones" style={{ marginTop: 12 }}>
            <button className="btn sello" disabled={ocupado || !previa
                                                    || !borrador.trim()
                                                    || borrador.length > (previa?.tope ?? 0)}
                    onClick={() => pedir(false)}>
              {ocupado && previa ? "Enviando…" : "Enviar por Telegram"}
            </button>
            {previa && borrador.length > previa.tope && (
              <button className="btn" onClick={copiar}>
                {copiado ? "Copiado ✓" : "Copiar el texto"}
              </button>
            )}
            <button className="btn" onClick={alCerrar}>Cancelar</button>
          </div>
        </>
      )}

      {aviso && <p className="calibre ok" style={{ marginTop: 10 }}>{aviso}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
