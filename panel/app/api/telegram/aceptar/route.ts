import { NextResponse } from "next/server";
import { clienteServidor } from "@/lib/supabase/servidor";
import { enviarTelegram } from "@/lib/telegram";
import { CIERRE } from "@/lib/bot-textos";

export const maxDuration = 20;

// Aceptar a quien le escribió al bot: lo vincula a un contacto (uno que ya
// existe, o uno nuevo con su nombre de Telegram y los temas en la nota) y
// le manda el cierre. Recién acá está "adentro", y es el clic de Leo lo que
// lo dispara: el bot solo no lo hace nunca.
//
// Los temas NO se cargan como encargo: van a la nota del contacto para que
// Leo arme el encargo a mano (decisión del 23/09/2026).
export async function POST(request: Request) {
  const supabase = await clienteServidor();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "sin sesión" }, { status: 401 });

  const cuerpo = await request.json().catch(() => ({}));
  const chatId = Number(cuerpo?.chat_id);
  const contactoId = cuerpo?.contacto_id ? Number(cuerpo.contacto_id) : null;
  if (!chatId) return NextResponse.json({ error: "falta chat_id" }, { status: 400 });

  const { data: chat } = await supabase.from("chats_telegram")
    .select("nombre,temas").eq("chat_id", chatId).maybeSingle();

  let nombre: string;
  if (contactoId) {
    const { data, error } = await supabase.from("contactos")
      .update({ telegram_id: chatId }).eq("id", contactoId).select("nombre").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    nombre = data.nombre;
  } else {
    nombre = chat?.nombre || "Sin nombre";
    const { error } = await supabase.from("contactos").insert({
      nombre, telegram_id: chatId,
      notas: chat?.temas ? `Pidió por el bot: ${chat.temas}` : null,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Ya quedó vinculado; si el cierre no sale, se avisa pero no se deshace.
  const fallo = await enviarTelegram(chatId, CIERRE(nombre.split(" ")[0]));
  return NextResponse.json({ ok: true,
    aviso: fallo ? `Quedó vinculado, pero no le llegó el mensaje de cierre: ${fallo}` : null });
}
