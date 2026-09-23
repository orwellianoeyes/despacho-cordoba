import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { enviarTelegram } from "@/lib/telegram";

export const maxDuration = 20;

// Lo que contesta el bot solo. Son las ÚNICAS dos cosas que salen sin que
// Leo las despache, y a propósito no dicen nada del Boletín: son recepción,
// no análisis. "Anotado" y no "adentro": el contacto queda adentro cuando
// Leo lo vincula, no cuando escribe.
const SALUDO = (nombre: string) =>
  `Hola${nombre ? ` ${nombre}` : ""}. Ya quedaste anotado en el Despacho Diario `
  + `del Boletín Oficial de Córdoba.\n\n`
  + `Contame qué temas te interesa vigilar, separados por coma. `
  + `Por ejemplo: obra vial, salud, paritaria docente.`;
// Afirmativo a propósito: "lo reviso y te aviso" lo dejaba esperando sin
// saber qué pasa. Lo de "aparece poco" lo cumple el botón de aviso que Leo
// tiene al calibrar; no se le contesta solo porque medir un tema son ~250
// consultas y es una evaluación que tiene que salir con su firma.
const ACUSE =
  `Listo, recibí tus temas. Los sumo a tu seguimiento y te voy mandando `
  + `las novedades del Boletín Oficial a medida que salgan. Si alguno `
  + `aparece muy poco, te aviso.`;

// Telegram avisa acá cada mensaje que recibe el bot. Viene sin sesión, así
// que el middleware lo deja pasar y la seguridad la pone el secreto: lo
// verifica la base (ver supabase/012_bot_recepcion.sql), no este archivo.
export async function POST(request: Request) {
  const secreto = request.headers.get("x-telegram-bot-api-secret-token");
  if (!secreto) return NextResponse.json({ error: "sin secreto" }, { status: 401 });

  const u = await request.json().catch(() => null);
  const m = u?.message;
  // Solo chats privados con texto. Un grupo o una foto se ignoran, pero
  // se responde 200: si no, Telegram reintenta el mismo aviso para siempre.
  if (!u?.update_id || !m?.chat?.id || m.chat.type !== "private") {
    return NextResponse.json({ ok: true });
  }

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,
                                process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
                                { auth: { persistSession: false } });
  const nombre = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ");
  const { data, error } = await supabase.rpc("recibir_telegram", {
    p_secreto: secreto, p_update_id: u.update_id, p_chat_id: m.chat.id,
    p_nombre: nombre || null,
    p_usuario: m.from?.username ? `@${m.from.username}` : null,
    p_texto: m.text ?? m.caption ?? "(sin texto)",
  }).single<{ n: number; vinculado: boolean }>();

  if (error) {
    // Secreto que no coincide: no es Telegram, o se reconectó el bot y
    // quedó un aviso viejo en vuelo. Cualquier otra cosa es la base: 500
    // para que Telegram reintente, que el update_id evita duplicar.
    const ajeno = error.code === "28000";
    return NextResponse.json({ error: ajeno ? "secreto inválido" : error.message },
                             { status: ajeno ? 401 : 500 });
  }

  if (data && !data.vinculado) {
    const texto = data.n === 1 ? SALUDO(m.from?.first_name ?? "")
                : data.n === 2 ? ACUSE : null;
    // Si la respuesta falla el mensaje igual quedó guardado, que es lo que
    // importa: Leo lo ve en Contactos. No se reintenta el aviso entero.
    if (texto) await enviarTelegram(m.chat.id, texto);
  }
  return NextResponse.json({ ok: true });
}
