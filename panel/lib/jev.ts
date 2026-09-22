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

import { readFile } from "node:fs/promises";
import path from "node:path";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODELO = "jev-latest";
const PRECIO_USD_POR_MILLON = 0.042;

// UNA norma por request. Parece caro y no lo es, porque lo que domina el
// costo es el texto de las preguntas (4 por norma), no el state — agrupar
// ahorraba poquísimo y costaba calidad.
//
// Medido el 22/09/2026 sobre las 23 normas del 18/09 y el encargo real:
//
//                               requests   tokens   entran   USD
//   lote de 20                        2    19.530     7/23   0,0008
//   de a una                         23    26.099     9/23   0,0011
//   de a una + texto de la página    23    51.811    14/23   0,0022
//
// **Meter 20 normas en un state diluye el juicio.** "Mantenimiento
// Puentes Red Vial Pavimentada Provincial" saca 0,66 en lote y 0,89 sola;
// su gemela, 0,77 y 0,94. Son obra vial y tienen que llegarle a quien
// pidió "obras": en lote quedaban afuera. Las dos entran de a una.
//
// **Y sumarle el texto de la página fue peor, no mejor.** Parecía gratis
// —el crudo ya está archivado y pago— pero una página del Boletín
// contiene VARIAS normas, así que el modelo le atribuye a una lo que dice
// la de al lado: "Adquisición Tarjetas Electrónicas Speed Tronic" pasó de
// 0,09 a 0,83, y los cables de EPEC de 0,23 a 0,80. Entraban 14 de 23,
// casi media edición. No reintentar esto sin resolver antes el recorte
// por norma, que hoy no existe.
//
// La nota es estable: dos corridas idénticas del lote dieron desvío medio
// 0,012 y ningún cambio de lado del umbral. Lo que mueve la nota es con
// quién viaja, no el azar.
const POR_LOTE = 1;

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

// El criterio vive en un .md, como los otros tres instructivos del
// proyecto: cambiar qué entra y qué no es editar texto, no tocar código.
// Ya se ganó el lugar — el 22/09/2026 Leo lo cambió para que una obra de
// generación eléctrica contara como obra, y eso movió diez notas.
let criterioCache: string | null = null;
async function criterio(): Promise<string> {
  if (criterioCache === null) {
    criterioCache = (await readFile(
      path.join(process.cwd(), "lib", "criterio-tema.md"), "utf-8")).trim();
  }
  return criterioCache;
}

async function juzgarLote(
  lote: Candidata[], temas: string[], clave_api: string
): Promise<{ juicios: Juicio[]; tokens: number }> {
  const reglas = await criterio();
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

  // Una pregunta por (norma, tema). Las de un mismo request corren en
  // paralelo, así que sumar temas no suma tiempo.
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
          criterio: reglas,
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

  // Una edición son ~45 requests. El tope publicado es 1.200 por minuto,
  // así que van todos juntos; lo que tarda es el más lento, no la suma.
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
