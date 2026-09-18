import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { clienteServidor } from "@/lib/supabase/servidor";

export const maxDuration = 60;

const MODELO = "claude-haiku-4-5";

export async function POST(request: Request) {
  const supabase = await clienteServidor();

  // Puerta de entrada. Aunque RLS ya protege las tablas, esta ruta gasta
  // créditos de API: no puede quedar abierta a cualquiera.
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "sin sesión" }, { status: 401 });

  const { id } = await request.json().catch(() => ({ id: null }));
  if (typeof id !== "number") {
    return NextResponse.json({ error: "falta el id de la norma" }, { status: 400 });
  }

  // Las consultas van con la sesión del usuario, así que RLS sigue aplicando.
  const { data: norma, error: e1 } = await supabase
    .from("normas")
    .select("id,fecha,tipo,numero,titulo,seccion,pagina,ampliada")
    .eq("id", id)
    .single();
  if (e1 || !norma) {
    return NextResponse.json({ error: "no encontré esa norma" }, { status: 404 });
  }
  if (norma.ampliada) {
    return NextResponse.json({ error: "ya estaba analizada" }, { status: 409 });
  }

  // El texto se archivó antes de que ninguna IA tocara el boletín, así que
  // es el original: (fecha, seccion, pagina) es justo lo que guarda la norma.
  const { data: pagina } = await supabase
    .from("paginas")
    .select("texto")
    .eq("fecha", norma.fecha).eq("seccion", norma.seccion).eq("pagina", norma.pagina)
    .maybeSingle();

  if (!pagina?.texto) {
    return NextResponse.json({
      error: "no hay texto archivado para esa página; corré boletin.py --fecha "
           + `${norma.fecha} --sin-ia`,
    }, { status: 422 });
  }

  const instrucciones = await readFile(
    path.join(process.cwd(), "lib", "instruccion-norma.md"), "utf-8");

  const anthropic = new Anthropic({ timeout: 55_000, maxRetries: 1 });
  let bruto: string;
  try {
    const r = await anthropic.messages.create({
      model: MODELO,
      max_tokens: 2000,
      system: instrucciones,
      messages: [{
        role: "user",
        content:
          `=== NORMA A ANALIZAR ===\n` +
          `Tipo: ${norma.tipo}\nNúmero: ${norma.numero}\nTítulo: ${norma.titulo}\n` +
          `Edición: ${norma.fecha} · Sección ${norma.seccion} · página ${norma.pagina}\n\n` +
          `=== TEXTO DE LA PÁGINA DEL BOLETÍN ===\n\n${pagina.texto}`,
      }],
    });
    bruto = r.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // El caso más común y el más confuso si no se nombra: sin crédito.
    const sinCredito = /credit balance is too low/i.test(msg);
    return NextResponse.json({
      error: sinCredito ? "La cuenta de Anthropic no tiene crédito." : msg,
    }, { status: 502 });
  }

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

  const { error: e2 } = await supabase.from("normas").update({
    importa: json.importa ?? null,
    ampliada,
    analizada_en: new Date().toISOString(),
    analizada_por: MODELO.startsWith("claude") ? "claude" : MODELO,
  }).eq("id", id);
  if (e2) return NextResponse.json({ error: e2.message }, { status: 500 });

  return NextResponse.json({ ampliada, importa: json.importa ?? null, motor: "claude" });
}
