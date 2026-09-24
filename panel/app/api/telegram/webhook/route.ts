import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { enviarTelegram } from "@/lib/telegram";
import { SALUDO, ACUSE, REPREGUNTA, PEDIDO, PEDIDO_DEL_RESUMEN,
         PIDE_CAMBIO } from "@/lib/bot-textos";

export const maxDuration = 20;

// Telegram avisa acá cada mensaje que recibe el bot. Viene sin sesión, así
// que el middleware lo deja pasar y la seguridad la pone el secreto: lo
// verifica la base (ver supabase/012 y 013), no este archivo.
//
// Reparto: acá se interpreta el texto y se elige qué decir; la base guarda
// en qué paso está cada persona y decide la acción. Los textos están en
// lib/bot-textos.ts. A un cliente ya aceptado el bot solo le acusa recibo
// de lo que pide; el contenido sale siempre despachado por Leo.
export async function POST(request: Request) {
  const secreto = request.headers.get("x-telegram-bot-api-secret-token");
  if (!secreto) return NextResponse.json({ error: "sin secreto" }, { status: 401 });

  const u = await request.json().catch(() => null);
  const m = u?.message;
  // Solo chats privados. Un grupo se ignora, pero se responde 200: si no,
  // Telegram reintenta el mismo aviso para siempre.
  if (!u?.update_id || !m?.chat?.id || m.chat.type !== "private") {
    return NextResponse.json({ ok: true });
  }

  const texto: string = m.text ?? m.caption ?? "(sin texto)";
  const intencion = /^\/start\b/.test(texto) ? "inicio"
                  : PIDE_CAMBIO.test(texto) ? "cambio" : "texto";

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,
                                process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
                                { auth: { persistSession: false } });
  const nombre = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ");
  const { data, error } = await supabase.rpc("recibir_telegram", {
    p_secreto: secreto, p_update_id: u.update_id, p_chat_id: m.chat.id,
    p_nombre: nombre || null,
    p_usuario: m.from?.username ? `@${m.from.username}` : null,
    p_texto: texto, p_intencion: intencion,
  }).single<{ accion: string | null; temas_anotados: string | null }>();

  if (error) {
    // Secreto que no coincide: no es Telegram, o se reconectó el bot y
    // quedó un aviso viejo en vuelo. Cualquier otra cosa es la base: 500
    // para que Telegram reintente, que el update_id evita duplicar.
    const ajeno = error.code === "28000";
    return NextResponse.json({ error: ajeno ? "secreto inválido" : error.message },
                             { status: ajeno ? 401 : 500 });
  }

  const respuesta =
      data?.accion === "saludo"      ? SALUDO(m.from?.first_name ?? "")
    : data?.accion === "acuse"       ? ACUSE(data.temas_anotados ?? texto)
    : data?.accion === "repreguntar" ? REPREGUNTA
    : data?.accion === "pedido"      ? PEDIDO
    : data?.accion === "pedido_del_resumen" ? PEDIDO_DEL_RESUMEN
    : null;
  // Si la respuesta falla el mensaje igual quedó guardado, que es lo que
  // importa: Leo lo ve en Contactos. No se reintenta el aviso entero.
  if (respuesta) await enviarTelegram(m.chat.id, respuesta);
  return NextResponse.json({ ok: true });
}
