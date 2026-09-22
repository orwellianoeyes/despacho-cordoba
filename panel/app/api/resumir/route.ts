import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { clienteServidor } from "@/lib/supabase/servidor";

// Medido el 18/09/2026 sobre una resolución del ERSeP de 6 páginas: 47
// segundos primero y 50 después de afinar el instructivo. El límite básico
// de Vercel son 60: el margen es demasiado fino para confiar, porque lo que
// marca el tiempo es cuánto escribe y una norma más larga escribe más.
//
// 300 es el techo de Fluid Compute. Si el plan no lo admite, el deploy
// falla con un mensaje claro: ahí se baja a 60 y se compensa recortando
// TOPE_PAGINAS, que es lo que acota la entrada.
export const maxDuration = 300;

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
// Entre Sonnet 5 y Opus 5 la diferencia es un dólar por mes a 20 análisis.
// Leo eligió Sonnet 5 (18/09/2026), y tiene a favor algo que no es el
// precio: es más rápido, y Vercel corta las funciones a los 60 segundos.
// Ese margen extra se gasta en `effort: high` en vez de `medium`, así que
// se compra mejor análisis con el mismo tiempo.
//
// Si al probarlo la calidad no alcanza, subir a "claude-opus-5" es cambiar
// esta línea — pero conviene bajar el esfuerzo a "medium" al hacerlo,
// porque Opus piensa más y puede pasarse del tiempo.
const MODOS = {
  corto: {
    modelo: "claude-haiku-4-5",
    instrucciones: "instruccion-norma.md",
    max_tokens: 2000,
  },
  extenso: {
    modelo: "claude-sonnet-5",
    instrucciones: "instruccion-extensa.md",
    // max_tokens cuenta el razonamiento, no solo la respuesta. Con 8000 y
    // effort "high" el modelo se gastaba casi todo pensando y la respuesta
    // salía truncada (stop_reason: max_tokens) con apenas 2.500 caracteres.
    // Con 16000 y "medium" produce los 10.000 que pide el instructivo y
    // termina solo. Medido: "medium" y "low" tardan lo mismo (47 s y 48 s),
    // así que el esfuerzo no era lo que costaba tiempo — era escribir.
    max_tokens: 16000,
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
  // es el original.
  //
  // Cuánto mandar, para el extenso: una sola página no alcanza. Probado con
  // la RG 123/2026 del ERSeP, que va de la página 12 a la 16 — con dos
  // páginas el texto llegaba cortado a mitad de frase, sin el "RESUELVE", y
  // el modelo (bien) se negaba a analizarla. La página donde arranca la
  // norma SIGUIENTE marca dónde termina ésta, y ese dato ya está en la
  // tabla. El tope acota el costo cuando el índice del día viene incompleto.
  //
  // Y se arranca UNA PÁGINA ANTES. Medido el 21/09/2026 contra el texto
  // crudo de las 41 ediciones: de 301 normas con número verificable, la
  // página citada es exacta en 265 (88%), pero cuando falla el sesgo es
  // de un solo lado — 34 citan DESPUÉS de donde la norma arranca y solo 2
  // antes. Empezar en la página citada le come el encabezado y los vistos
  // a ese 12%. Una página de más cuesta décimas de centavo; perderse el
  // arranque de la norma invalida el análisis.
  const TOPE_PAGINAS = 6;
  const desde = Math.max(1, norma.pagina - 1);
  let hasta = norma.pagina;
  if (modo === "extenso") {
    const { data: siguiente } = await supabase.from("normas")
      .select("pagina")
      .eq("fecha", norma.fecha).eq("seccion", norma.seccion)
      .gt("pagina", norma.pagina)
      .order("pagina", { ascending: true }).limit(1).maybeSingle();
    hasta = Math.min(siguiente?.pagina ?? norma.pagina + 2,
                     norma.pagina + TOPE_PAGINAS);
  }
  const { data: paginas } = await supabase
    .from("paginas")
    .select("pagina,texto")
    .eq("fecha", norma.fecha).eq("seccion", norma.seccion)
    .gte("pagina", desde).lte("pagina", hasta)
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
