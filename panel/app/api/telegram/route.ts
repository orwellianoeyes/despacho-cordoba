import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { clienteServidor } from "@/lib/supabase/servidor";

export const maxDuration = 20;

// Pedirle a un cliente su "ID de Telegram" es pedirle que abra una URL con
// un token y busque un número dentro de un JSON. Es absurdo para alguien
// que solo quiere recibir un resumen.
//
// Lo que sí puede hacer cualquiera: escribirle "hola" al bot. Telegram se lo
// avisa al webhook (api/telegram/webhook), que lo guarda en
// `mensajes_telegram`, y acá Leo lo ve y lo vincula de un clic.
//
// Antes esto se leía con getUpdates, que Telegram descarta a las 24 horas y
// que deja de funcionar apenas hay un webhook. Ahora no se pierde nada.
// Aceptar a alguien es otra ruta (api/telegram/aceptar): le manda el cierre.
type Chat = { chat_id: number; nombre: string | null; usuario: string | null;
              estado: string; temas: string | null; temas_anteriores: string | null;
              actualizado_en: string };
type Mensaje = { chat_id: number; texto: string | null };

// Quiénes escribieron y todavía no fueron aceptados, el más reciente
// primero. Con sus temas VIGENTES, los anteriores si los cambió, y todo lo
// que escribió: lo que no es tema ("una consulta…") también hay que leerlo.
export async function GET() {
  const supabase = await clienteServidor();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "sin sesión" }, { status: 401 });

  const [{ data: chats, error }, { data: contactos }] = await Promise.all([
    supabase.from("chats_telegram")
      .select("chat_id,nombre,usuario,estado,temas,temas_anteriores,actualizado_en")
      .order("actualizado_en", { ascending: false }).limit(100),
    supabase.from("contactos").select("telegram_id"),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const yaEstan = new Set((contactos ?? [])
    .map((c: { telegram_id: number | null }) => c.telegram_id).filter(Boolean));
  const pendientes = ((chats ?? []) as Chat[]).filter((c) => !yaEstan.has(c.chat_id));
  // Solo los mensajes de los pendientes: la tabla crece con todos los chats.
  const { data: mensajes } = pendientes.length
    ? await supabase.from("mensajes_telegram").select("chat_id,texto")
        .in("chat_id", pendientes.map((c) => c.chat_id))
        .order("recibido_en", { ascending: true })
    : { data: [] };
  const textos = new Map<number, string[]>();
  for (const m of (mensajes ?? []) as Mensaje[]) {
    if (!m.texto || m.texto.startsWith("/start")) continue;
    textos.set(m.chat_id, [...(textos.get(m.chat_id) ?? []), m.texto]);
  }

  const quienes = pendientes.map((c) => ({
    id: c.chat_id, nombre: c.nombre || "sin nombre", usuario: c.usuario,
    estado: c.estado, temas: c.temas, temas_anteriores: c.temas_anteriores,
    cuando: c.actualizado_en, textos: textos.get(c.chat_id) ?? [],
  }));

  return NextResponse.json({ quienes, bot: await estadoBot() });
}

// Conectar el bot: genera un secreto nuevo, lo guarda en la base y le dice a
// Telegram a dónde avisar. Hace falta una sola vez, o de nuevo si cambia el
// dominio del panel. Rehacerlo no rompe nada.
export async function POST() {
  const supabase = await clienteServidor();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "sin sesión" }, { status: 401 });

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const dominio = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (!token) return NextResponse.json({ error: "falta TELEGRAM_BOT_TOKEN" }, { status: 500 });
  if (!dominio) {
    return NextResponse.json({ error: "esto se conecta desde el panel publicado en Vercel, "
                                    + "no desde la Mac" }, { status: 422 });
  }

  const secreto = randomBytes(32).toString("hex");
  const { error } = await supabase.from("bot")
    .upsert({ id: 1, secreto, actualizado_en: new Date().toISOString() });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: `https://${dominio}/api/telegram/webhook`,
                           secret_token: secreto, allowed_updates: ["message"] }),
  });
  const c = await r.json().catch(() => ({}));
  if (!c?.ok) {
    return NextResponse.json({ error: `Telegram no aceptó el webhook: ${c?.description ?? r.status}` },
                             { status: 502 });
  }
  return NextResponse.json({ bot: await estadoBot() });
}

// Lo que Telegram sabe del webhook. `ultimo_error` es la prueba real de que
// funciona: si Vercel lo frena (protección de despliegue, middleware) acá
// aparece "Wrong response from the webhook: 401" o parecido.
async function estadoBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  const r = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`,
                        { cache: "no-store" });
  const c = await r.json().catch(() => ({}));
  const w = c?.result;
  if (!w) return null;
  return {
    conectado: Boolean(w.url),
    url: w.url || null,
    pendientes: w.pending_update_count ?? 0,
    ultimo_error: w.last_error_message ?? null,
    error_en: w.last_error_date ? new Date(w.last_error_date * 1000).toISOString() : null,
  };
}
