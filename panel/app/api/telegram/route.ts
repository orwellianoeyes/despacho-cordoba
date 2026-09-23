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
type Fila = { chat_id: number; nombre: string | null; usuario: string | null;
              texto: string | null; recibido_en: string };

export async function GET() {
  const supabase = await clienteServidor();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "sin sesión" }, { status: 401 });

  const [{ data: filas, error }, { data: contactos }] = await Promise.all([
    supabase.from("mensajes_telegram")
      .select("chat_id,nombre,usuario,texto,recibido_en")
      .order("recibido_en", { ascending: false }).limit(300),
    supabase.from("contactos").select("telegram_id"),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Los que ya están vinculados no se ofrecen de nuevo.
  const yaEstan = new Set((contactos ?? [])
    .map((c: { telegram_id: number | null }) => c.telegram_id).filter(Boolean));

  // Uno por persona, el más reciente primero, con TODO lo que escribió:
  // el segundo mensaje suele ser la lista de temas, y eso es lo que Leo
  // tiene que leer para armar el encargo.
  const porChat = new Map<number, { id: number; nombre: string; usuario: string | null;
                                    cuando: string; textos: string[] }>();
  for (const f of (filas ?? []) as Fila[]) {
    if (yaEstan.has(f.chat_id)) continue;
    const q = porChat.get(f.chat_id) ?? { id: f.chat_id, nombre: f.nombre || "sin nombre",
                                         usuario: f.usuario, cuando: f.recibido_en,
                                         textos: [] };
    if (f.texto && f.texto !== "/start") q.textos.unshift(f.texto);
    porChat.set(f.chat_id, q);
  }

  return NextResponse.json({ quienes: [...porChat.values()], bot: await estadoBot() });
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
