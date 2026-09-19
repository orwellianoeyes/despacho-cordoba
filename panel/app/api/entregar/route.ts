import { NextResponse } from "next/server";
import { clienteServidor } from "@/lib/supabase/servidor";

export const maxDuration = 30;

type Norma = {
  id: number; tipo: string; numero: string; titulo: string;
  seccion: string; pagina: number; url_oficial: string | null;
  importa: string | null;
  ampliada: { juridica?: string; politica?: string;
              oficialista?: string; opositora?: string } | null;
  extenso: string | null;
  temas_que_pegaron: string[];
};

type Formato = "breve" | "completo" | "extenso";

// Telegram corta los mensajes en 4096 caracteres. Si se pasa, no manda un
// mensaje cortado: rechaza el envío entero.
const TOPE_TELEGRAM = 4096;

// Cuánto ocupa cada norma, medido sobre las 335 analizadas:
//
//   breve     512 caracteres  →  entran 8 normas en un mensaje
//   completo  1652            →  entran 2,5
//
// Telegram corta en 4096. Por eso el diario va breve: es el menú, no la
// comida. Quien quiera profundidad la pide, y ahí se manda esa norma sola
// en completo o extenso. Nadie lee mil ochocientas palabras en el celular.
function armarMensaje(fecha: string, etiqueta: string, normas: Norma[],
                      formato: Formato): string {
  const dia = new Date(fecha + "T12:00:00-03:00").toLocaleDateString("es-AR",
    { weekday: "long", day: "numeric", month: "long" });

  // Sin link al panel y sin mención al sistema: el cliente recibe su
  // resumen, no una ventana a la herramienta.
  const partes = [
    `📋 Boletín Oficial de Córdoba — ${dia}`,
    `Seguimiento: ${etiqueta}`,
    "",
  ];

  normas.forEach((n, i) => {
    const num = normas.length > 1 ? `${i + 1}. ` : "";
    partes.push(`${num}${n.tipo}${n.numero ? ` N° ${n.numero}` : ""}`);
    partes.push(n.titulo);

    if (formato === "extenso" && n.extenso) {
      // El markdown de los títulos no aporta en Telegram: se limpia.
      partes.push("\n" + n.extenso.replace(/^#{1,3}\s*/gm, "").trim());
    } else {
      if (n.importa) partes.push(`\n${n.importa}`);
      if (formato === "completo") {
        if (n.ampliada?.juridica) partes.push(`\nLo jurídico: ${n.ampliada.juridica}`);
        if (n.ampliada?.politica) partes.push(`\nLo político: ${n.ampliada.politica}`);
        if (n.ampliada?.oficialista) partes.push(`\nMirada oficialista: ${n.ampliada.oficialista}`);
        if (n.ampliada?.opositora) partes.push(`\nMirada opositora: ${n.ampliada.opositora}`);
      }
    }

    if (n.url_oficial) partes.push(`\nTexto oficial: ${n.url_oficial}#page=${n.pagina}`);
    partes.push("\n" + "—".repeat(20) + "\n");
  });

  if (formato === "breve" && normas.length > 1) {
    partes.push("Si querés el análisis completo de alguna, avisame y te lo mando.\n");
  }
  partes.push("Análisis asistido por IA sobre el texto oficial publicado. "
            + "Contrastar con el Boletín antes de citarlo.");
  return partes.join("\n");
}

export async function POST(request: Request) {
  const supabase = await clienteServidor();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "sin sesión" }, { status: 401 });

  const cuerpo = await request.json().catch(() => ({}));
  const encargo_id = cuerpo?.encargo_id;
  const fecha = cuerpo?.fecha;
  const soloVistaPrevia = cuerpo?.previa === true;
  const formato: Formato = ["breve", "completo", "extenso"].includes(cuerpo?.formato)
    ? cuerpo.formato : "breve";
  const idsElegidos: number[] | null = Array.isArray(cuerpo?.ids) ? cuerpo.ids : null;

  if (typeof encargo_id !== "number" || !/^\d{4}-\d{2}-\d{2}$/.test(String(fecha))) {
    return NextResponse.json({ error: "faltan encargo o fecha" }, { status: 400 });
  }

  const { data: encargo } = await supabase
    .from("encargos").select("id,etiqueta,contacto_id,contactos(nombre,telegram_id)")
    .eq("id", encargo_id).single();
  if (!encargo) return NextResponse.json({ error: "no encontré el encargo" }, { status: 404 });

  const { data: todas, error: e1 } = await supabase
    .rpc("normas_del_encargo", { p_encargo: encargo_id, p_fecha: fecha });
  if (e1) return NextResponse.json({ error: e1.message }, { status: 500 });

  let normas = (todas ?? []) as Norma[];
  if (idsElegidos) normas = normas.filter((n) => idsElegidos.includes(n.id));
  if (!normas.length) {
    return NextResponse.json({ error: "no hay normas para enviar" }, { status: 422 });
  }

  // El texto que llegue desde el panel gana: Leo lo edita en la vista
  // previa antes de mandarlo. El armado automático es el borrador, no la
  // última palabra — en un servicio donde él es el editor, lo que sale
  // lleva su firma.
  const editado = typeof cuerpo?.texto === "string" ? cuerpo.texto.trim() : "";
  if (formato === "extenso") {
    const sinExtenso = normas.filter((n) => !n.extenso);
    if (sinExtenso.length) {
      return NextResponse.json({
        error: `Estas todavía no tienen análisis extenso: `
             + sinExtenso.map((n) => n.titulo.slice(0, 40)).join(" · ")
             + `. Generalo desde el Buscador primero.`,
      }, { status: 422 });
    }
  }
  const texto = editado || armarMensaje(fecha, encargo.etiqueta, normas, formato);

  // Vista previa: se devuelve el mensaje exacto que saldría, sin mandarlo.
  // Nada sale sin que Leo lo haya visto antes.
  if (soloVistaPrevia) {
    return NextResponse.json({ texto, cuantas: normas.length, largo: texto.length,
                               tope: TOPE_TELEGRAM });
  }

  const contacto = (encargo as unknown as
    { contactos: { nombre: string; telegram_id: number | null } }).contactos;
  if (!contacto?.telegram_id) {
    return NextResponse.json({
      error: `${contacto?.nombre ?? "el contacto"} todavía no tiene ID de Telegram. `
           + `Tiene que escribirle al bot una vez para que el sistema lo conozca.`,
    }, { status: 422 });
  }
  if (texto.length > TOPE_TELEGRAM) {
    return NextResponse.json({
      error: `El mensaje tiene ${texto.length} caracteres y Telegram corta en `
           + `${TOPE_TELEGRAM}. Sacá alguna norma de la selección.`,
    }, { status: 422 });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "falta TELEGRAM_BOT_TOKEN en el entorno" },
                             { status: 500 });
  }

  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: contacto.telegram_id, text: texto,
                           disable_web_page_preview: true }),
  });
  const respuesta = await r.json().catch(() => ({}));
  if (!r.ok || !respuesta?.ok) {
    return NextResponse.json({
      error: `Telegram rechazó el envío: ${respuesta?.description ?? r.status}`,
    }, { status: 502 });
  }

  // La bitácora guarda el texto que REALMENTE salió, no el que se armaría
  // hoy: el análisis puede cambiar después y hay que saber qué leyó.
  const { error: e2 } = await supabase.from("entregas").insert({
    contacto_id: encargo.contacto_id, encargo_id, fecha,
    norma_ids: normas.map((n) => n.id),
    canal: "telegram", estado: "enviada", texto,
    enviada_en: new Date().toISOString(),
  });
  if (e2) {
    // El mensaje ya salió: no se puede deshacer. Se avisa para que quede
    // constancia de que la bitácora quedó incompleta.
    return NextResponse.json({
      enviada: true,
      aviso: `Se envió, pero no pude anotarlo en la bitácora: ${e2.message}`,
    });
  }
  return NextResponse.json({ enviada: true, cuantas: normas.length });
}
