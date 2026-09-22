# Puntos a revisar — Despacho Córdoba

**Fecha:** 21 de septiembre de 2026
**Origen:** revisión del motor compartido entre los proyectos.
**Estado:** ninguno arreglado todavía. Lista de trabajo, no de reproches.

Este es **el proyecto con más en juego de todos**: es el único cuyo output
sale con firma profesional hacia un cliente que paga.

---

## Prioridad

| # | Punto | Riesgo |
|---|---|---|
| 1 | Sin aviso cuando NO hubo despacho | alto |
| 2 | Validación sintáctica, no de contenido | alto |
| 3 | La URL del Boletín puede cambiar | alto |
| 4 | Sin tests | medio |
| 5 | Editar `instrucciones.md` sin red de regresión | medio |
| 6 | No reproducible / deriva de modelos | medio |
| 7 | Sin prompt caching | bajo (hoy) |
| 8 | Actions no es orquestador | bajo |
| 9 | El repo crece para siempre | bajo |
| 10 | Vercel Hobby si el panel se comercializa | a futuro |

---

## 1. Sin aviso cuando NO hubo despacho — ALTO

`boletin.py` sale en silencio si el boletín todavía no salió. Es lo
correcto, **pero el silencio se ve idéntico cuando la fuente se rompió**.
Hoy no hay forma de distinguir "todavía no publicaron" de "hace tres días
que esto no funciona".

`avisar_error()` existe y cubre las excepciones. No cubre el caso
"terminó bien, sin hacer nada, tres días seguidos".

**Arreglo:** un aviso invertido (*deadman switch*). Si es día hábil y a
las 12:00 no hay archivo en `docs/data/` para hoy → Telegram. Media hora
de trabajo y tapa el punto ciego más grande del proyecto.

## 2. Validación sintáctica, no de contenido — ALTO

`_parsear()` valida que el JSON tenga forma válida y reintenta si viene
roto. Eso confirma **la forma**, no **la verdad**: el modelo puede
atribuir mal una página, mezclar dos resoluciones o citar una norma que
no está.

El análisis extenso va a clientes. No hay ninguna capa entre la salida
del modelo y el cliente.

**Lo llamativo:** este problema ya lo resolviste dos veces en otros lados
— `guardia.py` en Bot de X y la carpeta `verificacion/` en App Sentiment,
con etiquetas propias de referencia. Ninguna de las dos está acá.

**Arreglo:** traer el enfoque de `verificacion/`: una muestra de análisis
etiquetada a mano, y un chequeo automático de lo verificable (¿la página
citada existe en `texto/`? ¿el número de norma aparece en el texto
fuente?). Eso último no necesita IA: es comparar contra el crudo que ya
guardás.

## 3. La URL del Boletín puede cambiar — ALTO

El patrón es `.../wp-content/4p96humuzp/AAAA/MM/N_Secc_DDMMAA.pdf`. Ese
`4p96humuzp` es una carpeta de subidas de WordPress. Si el sitio migra,
se reorganiza o rota ese directorio, el motor deja de encontrar todo.

No depende de vos y no se puede prevenir. Lo que sí se puede es
**enterarse rápido** — que es el punto 1.

## 4. Sin tests — MEDIO

Verificado: no hay carpeta `tests/`. Un cambio en `extraer_paginas()` o
en `normalizar_paginas()` no rompe con error rojo: entrega datos peores
en silencio.

**Arreglo mínimo:** dos o tres tests sobre un boletín guardado de
`texto/` (ya tenés 41 días archivados, es material de prueba gratis).

## 5. Editar `instrucciones.md` sin red de regresión — MEDIO

Es el lado B de tener el criterio en un `.md`: cambiarlo es fácil, y
**empeorarlo es igual de fácil y silencioso**. No hay un conjunto de
casos contra el cual comparar antes y después.

Aplica a los tres instructivos: `instrucciones.md`,
`panel/lib/instruccion-norma.md` y `panel/lib/instruccion-extensa.md`.

## 6. No reproducible / deriva de modelos — MEDIO

El mismo boletín analizado dos veces da textos distintos. Si un cliente
pregunta por qué su análisis difiere del que viste vos, la respuesta
honesta es "es un modelo probabilístico".

Además los modelos se mueven: ya viviste que los 2.5 murieran, y los
alias `*-latest` cambian de comportamiento sin cambiar de nombre.

**Mitigación parcial:** guardar junto a cada despacho el modelo y la
fecha exactos con que se generó, para poder explicar diferencias.

## 7. Sin prompt caching — BAJO HOY

Verificado: no se usa `cache_control` en ningún lado. Cada corrida paga
`instrucciones.md` completo de nuevo. Con un solo cliente da igual; el
día que sean varios, es la diferencia entre costo lineal y costo que
baja por escala.

## 8. Actions no es orquestador — BAJO

Los cron programados llegan tarde bajo carga y **se desactivan solos tras
60 días sin actividad en el repo**. Despacho zafa porque commitea todos
los días hábiles. Tenerlo presente si alguna vez baja la frecuencia.

## 9. El repo crece para siempre — BAJO

`.git` va por 5 MB y `texto/` acumula un JSON por día hábil. Hoy no
molesta. En dos años, sí. Supabase ya se lleva la carga principal
(17 MB de 500), así que el camino está abierto: `texto/` podría vivir
allá y salir del repo.

## 10. Vercel Hobby — A FUTURO

El plan gratuito de Vercel es para uso no comercial. Desde que le cobres
a alguien por el panel, corresponde Pro (USD 20/mes). Saberlo antes de
facturar, no después.

---

## Lo que ya está bien (para calibrar)

- `.env` no versionado, con comodín que cubre variantes. Esto es lo que
  hunde a la mayoría de los proyectos chicos.
- El crudo guardado en `texto/` — permite reprocesar sin volver a pedirle
  nada a la fuente. Muy poca gente lo hace.
- El buzón: la nube nunca llama a la Mac. Sin puertos abiertos.
- Reintento distinguido: JSON roto sí, clave vencida no.
- RLS en las 9 tablas, service_role solo en el motor.
