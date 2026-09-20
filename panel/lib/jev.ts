// Jev (TypeSafe): juicios tipados, no texto generado. Se le da un estado y
// preguntas, devuelve probabilidades que el código consume directo.
//
// Acá reemplaza al filtro por palabra que decidía qué recibe cada cliente.
// El porqué está medido en `supabase/010_emparejar_por_significado.sql`.
//
// Se usa `fetch` contra la API y no el SDK a propósito: el contrato es una
// sola llamada, el motor en Python ya habla con la misma API de la misma
// forma, y así el panel no suma una dependencia más.
//
// Límites reales del modelo (docs.typesafe.ai/models): 64k tokens por
// request en total, 32k para el state más la pregunta más larga. Entrada a
// USD 0,042 por millón; la salida no se cobra.

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODELO = "jev-latest";
const PRECIO_USD_POR_MILLON = 0.042;

// Cuántas normas van en un request. Las preguntas de un mismo request
// corren en paralelo y comparten el state, así que agrupar es lo que abarata:
// 20 normas × 4 temas son 80 preguntas sobre un state de ~3 mil tokens.
//
// La docs no publica un tope de preguntas por request (sí de tokens: 64k en
// total, 32k para el state). Si alguna vez la API rechaza el lote, bajar
// este número es el arreglo — cuesta más plata, no menos calidad.
const POR_LOTE = 20;

// El `importa` de una norma analizada puede ser largo y no hace falta
// entero para decidir de qué trata.
const TOPE_IMPORTA = 600;

export type Candidata = {
  id: number;
  tipo: string | null;
  numero: string | null;
  titulo: string | null;
  importa: string | null;
};

export type Juicio = {
  norma_id: number;
  prob: number;                    // la más alta de todos los temas
  probs: Record<string, number>;   // una por tema
};

export type Resultado = {
  juicios: Juicio[];
  tokens: number;
  costo: number;
  evaluadas: number;
};

function clave(): string {
  const k = process.env.TYPESAFE_API_KEY?.trim();
  if (!k) {
    throw new Error(
      "Falta TYPESAFE_API_KEY. En local sale del .env del repo padre (ver dev.sh); "
      + "en Vercel se carga como Environment Variable del proyecto."
    );
  }
  return k;
}

type Respuesta = {
  answers: Record<string, { noul?: number }>;
  usage?: { input_tokens?: number };
};

async function juzgarLote(
  lote: Candidata[], temas: string[], clave_api: string
): Promise<{ juicios: Juicio[]; tokens: number }> {
  const state = {
    contexto:
      "Normas publicadas en el Boletín Oficial de la Provincia de Córdoba, "
      + "Argentina. Cada una es un acto de gobierno: una ley, un decreto, una "
      + "resolución, una licitación o un edicto.",
    normas: lote.map((n, i) => ({
      indice: i,
      tipo: n.tipo ?? "",
      numero: n.numero ?? "",
      titulo: n.titulo ?? "",
      resumen: (n.importa ?? "").slice(0, TOPE_IMPORTA),
    })),
  };

  // Una pregunta por (norma, tema). Van todas juntas porque agregar
  // preguntas sobre el mismo state no agrega latencia.
  const questions: Record<string, unknown> = {};
  lote.forEach((_, i) => {
    temas.forEach((tema, j) => {
      questions[`n${i}_t${j}`] = {
        type: "noul",
        instructions: {
          tarea:
            "Alguien pidió que le avisen cuando salga algo sobre un tema. "
            + "Decidir si esta norma en particular es una de esas.",
          norma: `\`normas[${i}]\``,
          tema,
          criterio:
            "Vale por lo que la norma dispone, no por las palabras que usa: "
            + "un caso concreto del tema cuenta aunque no lo nombre. "
            + "Una mención de paso, o el organismo apareciendo solo como "
            + "firmante, no cuenta.",
        },
        criteria: {
          true: `Lo que dispone \`normas[${i}]\` es del tema «${tema}».`,
          false: `\`normas[${i}]\` es de otra cosa, o solo roza «${tema}».`,
        },
      };
    });
  });

  const r = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${clave_api}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODELO, state, questions }),
  });
  if (!r.ok) {
    throw new Error(`TypeSafe ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const data = (await r.json()) as Respuesta;

  const juicios = lote.map((n, i) => {
    const probs: Record<string, number> = {};
    temas.forEach((tema, j) => {
      probs[tema] = data.answers?.[`n${i}_t${j}`]?.noul ?? 0;
    });
    return {
      norma_id: n.id,
      prob: Math.max(0, ...Object.values(probs)),
      probs,
    };
  });
  return { juicios, tokens: data.usage?.input_tokens ?? 0 };
}

/** Juzga cada norma contra cada tema. Devuelve TODAS, con su probabilidad:
 *  el umbral se aplica al leer, así que moverlo no vuelve a gastar. */
export async function juzgar(
  candidatas: Candidata[], temas: string[]
): Promise<Resultado> {
  const limpios = temas.map((t) => t.trim()).filter(Boolean);
  if (!candidatas.length || !limpios.length) {
    return { juicios: [], tokens: 0, costo: 0, evaluadas: 0 };
  }
  const clave_api = clave();

  const lotes: Candidata[][] = [];
  for (let i = 0; i < candidatas.length; i += POR_LOTE) {
    lotes.push(candidatas.slice(i, i + POR_LOTE));
  }

  const partes = await Promise.all(
    lotes.map((l) => juzgarLote(l, limpios, clave_api))
  );

  const juicios = partes.flatMap((p) => p.juicios);
  const tokens = partes.reduce((a, p) => a + p.tokens, 0);
  return {
    juicios,
    tokens,
    costo: (tokens / 1_000_000) * PRECIO_USD_POR_MILLON,
    evaluadas: candidatas.length,
  };
}
