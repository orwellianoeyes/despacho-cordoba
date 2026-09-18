import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { clienteServidor } from "@/lib/supabase/servidor";

export const maxDuration = 60;

// Dos trabajos, dos modelos, a propósito.
//
// El resumen corto es triage: sirve para mirar de reojo si una norma
// importa, y se usa mucho. Haiku alcanza y cuesta centésimos.
//
// El extenso es lo que se le manda a un cliente que pagó por entender una
// norma. Pasa pocas veces por semana, así que el costo no es el criterio.
//
// Costo por análisis extenso (~3.200 tokens de entrada, ~2.500 de salida):
//
//   claude-haiku-4-5   1,6 ¢     $1 / $5   por millón
//   claude-sonnet-5    3   ¢     $2 / $10
//   claude-opus-4-8    8   ¢     $5 / $25   ← mismo precio que Opus 5,
//   claude-opus-5      8   ¢     $5 / $25      pero generación anterior
//
// Opus 4.8 queda descartado: cuesta igual que Opus 5 siendo más viejo.
// Entre Sonnet 5 y Opus 5 la diferencia es un dólar por mes a 20 análisis,
// pero Sonnet es más rápido — y Vercel corta a los 60 segundos. Si el
// extenso se pasa de tiempo, bajar a "claude-sonnet-5" es cambiar esta
// línea y nada más.
const MODOS = {
  corto: {
    modelo: "claude-haiku-4-5",
    instrucciones: "instruccion-norma.md",
    max_tokens: 2000,
  },
  extenso: {
    modelo: "claude-opus-5",
    instrucciones: "instruccion-extensa.md",
    max_tokens: 8000,
    // Opus 5 piensa por defecto. 'medium' da un análisis sólido dentro de
    // los 60 segundos que da Vercel; subirlo a 'high' mejora el resultado
    // pero puede pasarse del tiempo.
    esfuerzo: "medium" as const,
  },
} as const;

type Modo = keyof typeof MODOS;

export async function POST(request: Request) {
  const supabase = await clienteServidor();

  // Puerta de entrada. Aunque RLS ya protege las tablas, esta ruta gasta
  // créditos de API: no puede quedar abierta a cualquiera.
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "sin sesión" }, { status: 401 });

  const cuerpo = await request.json().catch(() => ({}));
  const id = cuerpo?.id;
  const modo: Modo = cuerpo?.modo === "extenso" ? "extenso" : "corto";
  if (typeof id !== "number") {
    return NextResponse.json({ error: "falta el id de la norma" }, { status: 400 });
  }
  const cfg = MODOS[modo];

  const { data: norma } = await supabase
    .from("normas")
    .select("id,fecha,tipo,numero,titulo,seccion,pagina,ampliada,extenso")
    .eq("id", id)
    .single();
  if (!norma) {
    return NextResponse.json({ error: "no encontré esa norma" }, { status: 404 });
  }
  if (modo === "corto" && norma.ampliada) {
    return NextResponse.json({ error: "ya estaba resumida" }, { status: 409 });
  }
  if (modo === "extenso" && norma.extenso) {
    return NextResponse.json({ error: "ya tenía análisis extenso" }, { status: 409 });
  }

  // El texto se archivó ANTES de que ninguna IA tocara el boletín, así que
  // es el original. Para el extenso se suma la página siguiente: una norma
  // larga puede arrancar en una página y seguir en la otra, y un análisis
  // cortado a la mitad es peor que ninguno.
  const hasta = modo === "extenso" ? norma.pagina + 1 : norma.pagina;
  const { data: paginas } = await supabase
    .from("paginas")
    .select("pagina,texto")
    .eq("fecha", norma.fecha).eq("seccion", norma.seccion)
    .gte("pagina", norma.pagina).lte("pagina", hasta)
    .order("pagina");

  const texto = (paginas ?? []).map((p) => p.texto).join("\n\n").trim();
  if (!texto) {
    return NextResponse.json({
      error: `no hay texto archivado para esa página; corré `
           + `boletin.py --fecha ${norma.fecha} --sin-ia`,
    }, { status: 422 });
  }

  const instrucciones = await readFile(
    path.join(process.cwd(), "lib", cfg.instrucciones), "utf-8");

  const usuario =
    `=== NORMA A ANALIZAR ===\n` +
    `Tipo: ${norma.tipo}\nNúmero: ${norma.numero}\nTítulo: ${norma.titulo}\n` +
    `Edición: ${norma.fecha} · Sección ${norma.seccion} · página ${norma.pagina}\n\n` +
    `=== TEXTO DEL BOLETÍN ===\n\n${texto}`;

  const anthropic = new Anthropic({ maxRetries: 1 });
  let bruto: string;
  try {
    // Streaming: con max_tokens alto evita que el pedido muera por timeout.
    const flujo = anthropic.messages.stream({
      model: cfg.modelo,
      max_tokens: cfg.max_tokens,
      system: instrucciones,
      messages: [{ role: "user", content: usuario }],
      ...("esfuerzo" in cfg ? { output_config: { effort: cfg.esfuerzo } } : {}),
    });
    const r = await flujo.finalMessage();
    if (r.stop_reason === "max_tokens") {
      return NextResponse.json(
        { error: "el análisis quedó cortado: hay que subir max_tokens" },
        { status: 502 });
    }
    bruto = r.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // El caso más común y el más confuso si no se nombra.
    const sinCredito = /credit balance is too low/i.test(msg);
    return NextResponse.json({
      error: sinCredito ? "La cuenta de Anthropic no tiene crédito." : msg,
    }, { status: 502 });
  }

  // ---- Extenso: markdown tal cual ----
  if (modo === "extenso") {
    const { error } = await supabase.from("normas").update({
      extenso: bruto.trim(),
      extenso_en: new Date().toISOString(),
      extenso_por: cfg.modelo,
    }).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ extenso: bruto.trim(), motor: cfg.modelo });
  }

  // ---- Corto: JSON con las cuatro miradas ----
  let json: Record<string, string>;
  try {
    json = JSON.parse(bruto.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return NextResponse.json({ error: "la IA no devolvió JSON válido" }, { status: 502 });
  }
  const ampliada = {
    juridica: json.juridica ?? "", politica: json.politica ?? "",
    oficialista: json.oficialista ?? "", opositora: json.opositora ?? "",
  };
  const { error } = await supabase.from("normas").update({
    importa: json.importa ?? null,
    ampliada,
    analizada_en: new Date().toISOString(),
    analizada_por: cfg.modelo,
  }).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ampliada, importa: json.importa ?? null, motor: cfg.modelo });
}
