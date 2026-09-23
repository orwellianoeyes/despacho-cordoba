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

type Formato = "titulares" | "breve" | "completo" | "extenso";

// El campo `importa` trae, después de la primera oración, la plata y las
// fechas — que es lo accionable. En el formato de titulares el título ya
// dice de qué se trata, así que se extraen solo esos datos duros.
const MONTO = /\$\s?[\d.]+(?:,\d+)?/;
const FECHA = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/;

function datosDuros(txt: string | null): string {
  if (!txt) return "";
  const partes: string[] = [];
  const m = txt.match(MONTO);
  if (m) partes.push(m[0].replace("$ ", "$"));
  const f = txt.match(FECHA);
  if (f) partes.push(`apertura ${f[0]}`);
  return partes.join(" · ");
}

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
  // Titulares: el mensaje de la mañana. El título ya dice qué es; se le
  // suman el tipo, el monto y la fecha de apertura, y el link. Medido:
  // 240 caracteres por norma contra 520 del formato con resumen, así que
  // entran 15 en vez de 8. Nadie lee más que eso en el celular antes del
  // café, y quien quiera profundidad la pide.
  if (formato === "titulares") {
    const p = [`📋 B.O. Córdoba · ${dia}`, etiqueta, ""];
    normas.forEach((n, i) => {
      p.push(`${i + 1}. ${n.titulo}`);
      const dd = datosDuros(n.importa);
      p.push(`   ${n.tipo}${dd ? ` · ${dd}` : ""}`);
      if (n.url_oficial) p.push(`   ${n.url_oficial}#page=${n.pagina}`);
      p.push("");
    });
    p.push("¿Querés el análisis de alguna? Avisame.");
    return p.join("\n");
  }

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
  const formato: Formato =
    ["titulares", "breve", "completo", "extenso"].includes(cuerpo?.formato)
      ? cuerpo.formato : "titulares";
  const idsElegidos: number[] | null = Array.isArray(cuerpo?.ids) ? cuerpo.ids : null;

  // Dos caminos de entrada, un solo motor de armado y envío.
  //
  //   encargo_id  la entrega de la mañana: lo que matcheó su encargo.
  //   contacto_id un envío suelto desde el Buscador, con las normas
  //               elegidas a mano. Es para cuando el cliente pide algo
  //               puntual que su encargo no cubre — "¿qué pasó con la
  //               ruta 9?" — y antes no había por dónde hacerlo.
  //
  // Lo que NO cambia en el camino suelto: la vista previa editable, el
  // tope de Telegram y la bitácora. Nada sale sin que Leo lo vea.
  const suelto = typeof cuerpo?.contacto_id === "number";

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha))
      || (!suelto && typeof encargo_id !== "number")) {
    return NextResponse.json({ error: "faltan destinatario o fecha" }, { status: 400 });
  }
  if (suelto && !idsElegidos?.length) {
    return NextResponse.json({ error: "no elegiste ninguna norma" }, { status: 400 });
  }

  let destino: { nombre: string; telegram_id: number | null } | null = null;
  let contacto_id: number | null = null;
  let etiqueta = "";
  let normas: Norma[] = [];

  if (suelto) {
    contacto_id = cuerpo.contacto_id as number;
    const { data: c } = await supabase.from("contactos")
      .select("id,nombre,telegram_id").eq("id", contacto_id).single();
    if (!c) return NextResponse.json({ error: "no encontré el contacto" }, { status: 404 });
    destino = c;
    etiqueta = "A pedido";

    // Se leen por id, sin pasar por `coincidencias`: el sentido de este
    // camino es justamente mandar algo que NO matcheó su encargo.
    const { data, error } = await supabase.from("normas")
      .select("id,tipo,numero,titulo,seccion,pagina,url_oficial,importa,ampliada,extenso")
      .in("id", idsElegidos!);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    normas = ((data ?? []) as unknown as Norma[])
      .map((x) => ({ ...x, temas_que_pegaron: [] }));
    if (!normas.length) {
      return NextResponse.json({ error: "esas normas ya no están" }, { status: 422 });
    }
  } else {
    const { data: encargo } = await supabase
      .from("encargos").select("id,etiqueta,contacto_id,contactos(nombre,telegram_id)")
      .eq("id", encargo_id).single();
    if (!encargo) return NextResponse.json({ error: "no encontré el encargo" }, { status: 404 });
    destino = (encargo as unknown as
      { contactos: { nombre: string; telegram_id: number | null } }).contactos;
    contacto_id = encargo.contacto_id;
    etiqueta = encargo.etiqueta;

    const { data: todas, error: e1 } = await supabase
      .rpc("normas_del_encargo", { p_encargo: encargo_id, p_fecha: fecha });
    if (e1) return NextResponse.json({ error: e1.message }, { status: 500 });
    normas = (todas ?? []) as Norma[];
    if (idsElegidos) normas = normas.filter((n) => idsElegidos.includes(n.id));
    if (!normas.length) {
      // `normas_del_encargo` lee de `coincidencias`: vacío puede ser "no le
      // toca nada" o "esta edición todavía no se emparejó".
      const { count } = await supabase.from("coincidencias")
        .select("norma_id", { count: "exact", head: true })
        .eq("encargo_id", encargo_id).eq("fecha", fecha);
      return NextResponse.json({
        error: (count ?? 0) > 0
          ? "no hay normas para enviar"
          : "esta edición todavía no se emparejó para este encargo",
      }, { status: 422 });
    }
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
  const texto = editado || armarMensaje(fecha, etiqueta, normas, formato);

  // Vista previa: se devuelve el mensaje exacto que saldría, sin mandarlo.
  // Nada sale sin que Leo lo haya visto antes.
  if (soloVistaPrevia) {
    return NextResponse.json({ texto, cuantas: normas.length, largo: texto.length,
                               tope: TOPE_TELEGRAM });
  }

  const contacto = destino;
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
    contacto_id, encargo_id: suelto ? null : encargo_id, fecha,
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
