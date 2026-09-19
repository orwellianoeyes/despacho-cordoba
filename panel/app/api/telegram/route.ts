import { NextResponse } from "next/server";
import { clienteServidor } from "@/lib/supabase/servidor";

export const maxDuration = 20;

// Pedirle a un cliente su "ID de Telegram" es pedirle que abra una URL con
// un token y busque un número dentro de un JSON. Es absurdo para alguien
// que solo quiere recibir un resumen.
//
// Lo que sí puede hacer cualquiera: escribirle "hola" al bot. Con eso
// Telegram nos cuenta quién fue y con qué id, y Leo lo vincula de un clic.
//
// Dos límites que conviene saber: getUpdates solo funciona si el bot no
// tiene un webhook configurado, y Telegram descarta los mensajes no leídos
// a las 24 horas. O sea que el cliente tiene que escribir y Leo vincular
// dentro del mismo día.
export async function GET() {
  const supabase = await clienteServidor();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "sin sesión" }, { status: 401 });

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "falta TELEGRAM_BOT_TOKEN en el entorno" },
                             { status: 500 });
  }

  const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=100`,
                        { cache: "no-store" });
  const c = await r.json().catch(() => ({}));
  if (!c?.ok) {
    return NextResponse.json({
      error: c?.description ?? "Telegram no respondió. "
           + "Si el bot tiene un webhook configurado, getUpdates no funciona.",
    }, { status: 502 });
  }

  // Quién escribió, sin repetidos, el más reciente primero.
  const vistos = new Map<number, { id: number; nombre: string; usuario: string | null;
                                   cuando: number; texto: string }>();
  for (const u of c.result ?? []) {
    const m = u.message ?? u.edited_message;
    if (!m?.chat?.id) continue;
    vistos.set(m.chat.id, {
      id: m.chat.id,
      nombre: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ")
              || m.chat?.title || "sin nombre",
      usuario: m.from?.username ? `@${m.from.username}` : null,
      cuando: m.date,
      texto: (m.text ?? "").slice(0, 60),
    });
  }

  // Los que ya están vinculados no se ofrecen de nuevo.
  const { data: contactos } = await supabase.from("contactos").select("telegram_id");
  const yaEstan = new Set((contactos ?? [])
    .map((c: { telegram_id: number | null }) => c.telegram_id).filter(Boolean));

  const quienes = [...vistos.values()]
    .filter((v) => !yaEstan.has(v.id))
    .sort((a, b) => b.cuando - a.cuando);

  return NextResponse.json({ quienes });
}
