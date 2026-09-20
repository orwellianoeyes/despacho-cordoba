import { NextResponse } from "next/server";
import { juzgar, type Candidata } from "@/lib/jev";
import { clienteServidor } from "@/lib/supabase/servidor";

export const maxDuration = 60;

// Cuánto pegaría un tema ANTES de guardarlo.
//
// La versión anterior contaba con la misma consulta por palabra que usaba
// el emparejador, así que confirmaba el tema con exactamente el mismo error
// que después le hacía perder normas: "obras" calibraba bien y entregaba el
// 45% de lo que correspondía. Un calibrador que miente en la misma
// dirección que el filtro es peor que no tener calibrador.
//
// Ahora juzga una muestra real y además devuelve TÍTULOS. El número solo
// dice cuántas; los títulos dicen si son las que él esperaba.
const EDICIONES = 10;

export async function POST(request: Request) {
  const supabase = await clienteServidor();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "sin sesión" }, { status: 401 });

  const cuerpo = await request.json().catch(() => ({}));
  const tema = String(cuerpo?.tema ?? "").trim();
  const secciones: string[] = Array.isArray(cuerpo?.secciones)
    ? cuerpo.secciones.map(String) : ["1", "4"];
  const umbral = typeof cuerpo?.umbral === "number" ? cuerpo.umbral : 0.7;

  if (!tema) return NextResponse.json({ error: "falta el tema" }, { status: 400 });

  const { data: candidatas, error } = await supabase
    .rpc("candidatas_recientes", { p_secciones: secciones, p_ediciones: EDICIONES });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const filas = (candidatas ?? []) as (Candidata & { fecha: string })[];
  if (!filas.length) {
    return NextResponse.json({ error: "no hay ediciones archivadas" }, { status: 422 });
  }

  let r;
  try {
    r = await juzgar(filas, [tema]);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }

  const porId = new Map(filas.map((f) => [f.id, f]));
  const pegan = r.juicios
    .filter((j) => j.prob >= umbral)
    .sort((a, b) => b.prob - a.prob)
    .map((j) => {
      const f = porId.get(j.norma_id)!;
      return { prob: j.prob, fecha: f.fecha, titulo: f.titulo ?? "" };
    });

  const ediciones = new Set(filas.map((f) => f.fecha)).size;
  return NextResponse.json({
    total: pegan.length,
    evaluadas: filas.length,
    ediciones,
    promedio_por_edicion: Math.round((pegan.length / ediciones) * 10) / 10,
    muestra: pegan.slice(0, 12),
    costo: r.costo,
  });
}
