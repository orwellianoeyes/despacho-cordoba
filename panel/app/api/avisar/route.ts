import { NextResponse } from "next/server";
import { clienteServidor } from "@/lib/supabase/servidor";
import { enviarTelegram } from "@/lib/telegram";

export const maxDuration = 20;

// Avisarle a un cliente que su tema aparece poco o nada en el Boletín.
// Sale del mismo número que ve Leo al calibrar, pero NO sale solo: el panel
// arma el borrador, Leo lo lee, lo corrige si quiere y lo manda. El texto
// llega ya editado; acá solo se envía y se anota en la bitácora.
export async function POST(request: Request) {
  const supabase = await clienteServidor();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "sin sesión" }, { status: 401 });

  const cuerpo = await request.json().catch(() => ({}));
  const contacto_id = Number(cuerpo?.contacto_id);
  const encargo_id = cuerpo?.encargo_id ? Number(cuerpo.encargo_id) : null;
  const texto = typeof cuerpo?.texto === "string" ? cuerpo.texto.trim() : "";
  if (!contacto_id || !texto) {
    return NextResponse.json({ error: "falta el contacto o el texto" }, { status: 400 });
  }

  const { data: c } = await supabase.from("contactos")
    .select("nombre,telegram_id").eq("id", contacto_id).single();
  if (!c?.telegram_id) {
    return NextResponse.json({ error: "este contacto todavía no tiene Telegram vinculado" },
                             { status: 422 });
  }

  const fallo = await enviarTelegram(c.telegram_id, texto);
  if (fallo) return NextResponse.json({ error: fallo }, { status: 502 });

  // Va a la misma bitácora que las entregas, sin normas: así queda en el
  // historial qué se le dijo y cuándo.
  const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Cordoba" });
  const { error } = await supabase.from("entregas").insert({
    contacto_id, encargo_id, fecha: hoy, norma_ids: [],
    canal: "telegram", estado: "enviada", texto,
    enviada_en: new Date().toISOString(),
  });
  if (error) {
    return NextResponse.json({ enviada: true,
      aviso: `Se envió, pero no pude anotarlo en la bitácora: ${error.message}` });
  }
  return NextResponse.json({ enviada: true });
}
