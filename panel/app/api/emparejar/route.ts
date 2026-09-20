import { NextResponse } from "next/server";
import { juzgar, type Candidata } from "@/lib/jev";
import { clienteServidor } from "@/lib/supabase/servidor";

// El emparejamiento corre acá y no en Postgres porque Supabase no deja
// instalar extensiones propias. El resultado es el mismo que un WHERE
// semántico; el lugar donde se ejecuta es distinto.
//
// Tiempo: los lotes van en paralelo y las preguntas de un lote también, así
// que una edición de ~45 normas contra 4 temas son 3 requests simultáneos.
// 60 segundos sobra, y a diferencia del análisis extenso acá no hay nada
// que escribir: Jev devuelve números, no texto.
export const maxDuration = 60;

// Se calcula una vez por (encargo, edición) y queda guardado. Abrir el
// panel diez veces no cuesta diez veces.
export async function POST(request: Request) {
  const supabase = await clienteServidor();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "sin sesión" }, { status: 401 });

  const cuerpo = await request.json().catch(() => ({}));
  const fecha = String(cuerpo?.fecha ?? "");
  const rehacer = cuerpo?.rehacer === true;
  const unSolo = typeof cuerpo?.encargo_id === "number" ? cuerpo.encargo_id : null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    return NextResponse.json({ error: "falta la fecha" }, { status: 400 });
  }

  // Qué encargos hay que mirar. Sin `encargo_id` se emparejan todos los
  // activos: es lo que hace falta para que el panorama de la mañana diga
  // la verdad sobre cuántas normas tiene cada uno.
  let consulta = supabase.from("encargos")
    .select("id,etiqueta,temas,secciones,umbral,activo").eq("activo", true);
  if (unSolo !== null) consulta = consulta.eq("id", unSolo);
  const { data: encargos, error: e1 } = await consulta;
  if (e1) return NextResponse.json({ error: e1.message }, { status: 500 });
  if (!encargos?.length) {
    return NextResponse.json({ hechos: [], costo: 0, tokens: 0 });
  }

  const hechos: { encargo_id: number; etiqueta: string; evaluadas: number;
                  coinciden: number; costo: number; reusado: boolean }[] = [];
  let tokensTotal = 0;

  for (const e of encargos) {
    const temas = (e.temas ?? []) as string[];
    const umbral = typeof e.umbral === "number" ? e.umbral : 0.7;

    // ¿Ya se evaluó esta edición para este encargo? La presencia de filas
    // alcanza para saberlo, porque se guardan TODAS las normas juzgadas y
    // no solo las que pegaron.
    if (!rehacer) {
      const { count } = await supabase.from("coincidencias")
        .select("norma_id", { count: "exact", head: true })
        .eq("encargo_id", e.id).eq("fecha", fecha);
      if ((count ?? 0) > 0) {
        const { count: pegan } = await supabase.from("coincidencias")
          .select("norma_id", { count: "exact", head: true })
          .eq("encargo_id", e.id).eq("fecha", fecha).gte("prob", umbral);
        hechos.push({ encargo_id: e.id, etiqueta: e.etiqueta, evaluadas: count ?? 0,
                      coinciden: pegan ?? 0, costo: 0, reusado: true });
        continue;
      }
    }

    if (!temas.length) continue;

    const { data: candidatas, error: e2 } = await supabase
      .rpc("candidatas_del_encargo", { p_encargo: e.id, p_fecha: fecha });
    if (e2) return NextResponse.json({ error: e2.message }, { status: 500 });
    if (!candidatas?.length) continue;

    let r;
    try {
      r = await juzgar(candidatas as Candidata[], temas);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 502 }
      );
    }
    tokensTotal += r.tokens;

    const filas = r.juicios.map((j) => ({
      encargo_id: e.id, norma_id: j.norma_id, fecha,
      prob: j.prob, probs: j.probs, calculada_en: new Date().toISOString(),
    }));
    const { error: e3 } = await supabase.from("coincidencias")
      .upsert(filas, { onConflict: "encargo_id,norma_id" });
    if (e3) return NextResponse.json({ error: e3.message }, { status: 500 });

    hechos.push({
      encargo_id: e.id, etiqueta: e.etiqueta, evaluadas: r.evaluadas,
      coinciden: r.juicios.filter((j) => j.prob >= umbral).length,
      costo: r.costo, reusado: false,
    });
  }

  return NextResponse.json({
    hechos, tokens: tokensTotal,
    costo: (tokensTotal / 1_000_000) * 0.042,
  });
}
