# Despacho Diario — Boletín Oficial de Córdoba

Sistema que descarga, analiza con IA y publica un resumen diario del
Boletín Oficial de la Provincia de Córdoba. Lo usa Leo, abogado y asesor
legislativo, para control público de normativa provincial.

## Cómo funciona (arquitectura)

- `boletin.py` — el motor. Descarga los PDFs del día, extrae texto,
  lo archiva en `texto/AAAA-MM-DD.json`, llama a la IA con
  `instrucciones.md`, guarda el resultado en `docs/data/AAAA-MM-DD.json`
  y avisa por Telegram. Se dispara a mano:

      python boletin.py                       # la edición de hoy
      python boletin.py --fecha 2026-09-08    # recuperar un día pasado
      python boletin.py --secciones 1,4,5     # elegir qué monitorear
      python boletin.py --sin-ia              # archivar el texto, sin IA
      python boletin.py --rehacer             # regenerar uno ya hecho
      python boletin.py --motor gemini        # última instancia (ver abajo)

- `texto/AAAA-MM-DD.json` — el texto crudo del boletín, página por
  página y por sección. **No es un subproducto: es lo que permite
  resumir después cualquier norma del índice.** El índice guarda
  (fecha, sección, página) de cada norma; con el texto guardado se la
  ubica sin volver a pedirle el PDF al Boletín. Acumula: correr un día
  con `--secciones 2` suma esa sección sin pisar las ya archivadas.
- `instrucciones.md` — el instructivo que le dice a la IA qué analizar,
  con qué extensión, y qué normas destacar. Es el "cerebro" editable:
  cambiar el análisis es editar texto, no código.
- `docs/index.html` — la app estática (GitHub Pages). Lee los JSON de
  `docs/data/` y los muestra. Tiene modo demo (datos de ejemplo
  embebidos) y modo real (si encuentra `data/ultimo.json`).
- `correr.sh` — ejecutor local: espera a tener conexión, corre el motor
  con hasta 3 reintentos, publica en GitHub si hay novedades.
- `com.leo.despacho.plist` — tarea de launchd (macOS) que dispara
  `correr.sh` lunes a viernes 7:30, 9:30, 11:30.

- `datos.py` — única puerta a Supabase. La usan el motor, el importador
  y el buzón. Usa la service_role, que saltea RLS: es la credencial del
  motor, nunca la del panel.
- `buzon.py` + `escuchar.sh` — la Mac le pregunta a Supabase si hay algo
  que hacer. **La nube nunca le habla a la Mac**: el panel deja el pedido
  en la tabla `corridas` y este proceso lo levanta, así no hay que abrir
  ningún puerto. Lo que viene de la base es DATO, no una orden: `fecha`,
  `secciones` y `motor` se validan antes de armar el comando, que además
  va como lista y nunca por shell.
- `migrar_a_supabase.py` — sube archivos sueltos a Supabase. Desde la
  Etapa 2.5 el motor sube solo al terminar, así que esto quedó para la
  carga inicial, rellenar días viejos, o recuperar una subida que falló.

- `panel/` — el panel privado (Next.js 16, sin Tailwind: CSS a mano con la
  misma paleta que la app pública). **Necesita Node 20+**; la Mac tiene
  v16 en el PATH y v20.20.2 por nvm, así que `dev.sh` fuerza la ruta de
  nvm. Levantarlo: `panel/dev.sh`.

  Dos cosas de seguridad que no hay que deshacer: la clave de Anthropic
  **no se copia** al panel — `dev.sh` la lee del `.env` del repo padre y
  vive solo en el entorno del proceso. Y la `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  sí está en claro a propósito: viaja al navegador por diseño y lo que
  protege los datos es RLS, no esconderla.

  Hay TRES instructivos, uno por trabajo, y los tres se editan como texto:
  `instrucciones.md` analiza la edición completa del día y elige las
  destacadas; `panel/lib/instruccion-norma.md` da el resumen corto de una
  norma que alguien fue a buscar; `panel/lib/instruccion-extensa.md` da el
  análisis en profundidad que se le manda a un cliente.

  **Modelo distinto por trabajo, decidido el 18/09/2026 con los precios a
  la vista** (costo de un análisis extenso típico, ~3.200 tokens de
  entrada y ~2.500 de salida):

      haiku-4-5    1,6 ¢    el despacho diario y el resumen corto
      sonnet-5     3   ¢    el análisis extenso  ← elegido
      opus-4-8     8   ¢    descartado: cuesta igual que Opus 5 y es anterior
      opus-5       8   ¢

  El diario sigue en Haiku porque son 100 mil caracteres todos los días y
  ahí manda el volumen. El extenso va en Sonnet 5: a 20 por mes la
  diferencia con Opus es un dólar, pero Sonnet es más rápido y el tiempo
  de función no es infinito. Ese margen se gasta en `effort: high`. Si la
  calidad no alcanza, subir a `claude-opus-5` y bajar el esfuerzo a
  `medium` en el mismo movimiento.

  **Cuánto texto recibe el extenso, medido el 18/09/2026 y no supuesto.**
  Una página no alcanza y dos tampoco: la RG 123/2026 del ERSeP va de la
  página 12 a la 16, y con dos el texto llegaba cortado a mitad de frase,
  sin el "RESUELVE". El modelo hizo lo correcto —se negó a analizarla y
  dijo qué le faltaba, en vez de inventar la parte resolutiva— pero el
  análisis no servía. Ahora el rango va hasta la página donde arranca la
  norma SIGUIENTE, dato que ya está en la tabla, con tope de 6 páginas
  por si el índice del día viene incompleto.

  **`max_tokens` cuenta el razonamiento, no solo la respuesta.** Con 8000
  y `effort: high`, Sonnet se gastaba casi todo pensando y la respuesta
  salía truncada (`stop_reason: max_tokens`) con 2.500 caracteres. Con
  16000 y `medium` produce los 10.000 que pide el instructivo y termina
  solo. Dato útil: `medium` y `low` tardan lo mismo (47 s y 48 s), así que
  el esfuerzo no era lo que costaba tiempo — era escribir la respuesta.

  Costo y tiempo reales de un extenso de 6 páginas: **50 segundos y 9,1
  centavos**, unos 11 mil caracteres. Lo que marca el tiempo es cuánto
  escribe, así que conviene margen de sobra: `maxDuration` está en 300.

  **Los 60 segundos de Vercel son folclore viejo y acá estaba mal escrito
  hasta el 21/09/2026.** Verificado en vercel.com/docs/functions/limitations:
  con Fluid Compute, que viene encendido por defecto en proyectos nuevos,
  **Hobby da 300 segundos de default y de máximo**; Pro llega a 800 y hay
  1800 en beta. El tope de 60 es de antes de Fluid. O sea que `maxDuration
  = 300` no puede hacer fallar el deploy por plan.

  **La agrupación de artículos es una regla, no criterio del modelo.**
  Puede agrupar SOLO artículos que dispongan literalmente lo mismo
  aplicado a sujetos distintos, y está obligado a decir que agrupó, cuáles
  y en qué se diferencian. Salió de ver que agrupaba bien pero por su
  cuenta: cuando esto va a clientes, dos análisis con criterios distintos
  se notan. Probado: ahora declara la agrupación y explica las
  diferencias, que es más informativo que siete viñetas repetidas.

Base: proyecto `despacho-cordoba` (São Paulo, plan free).
  URL  https://rtawftdaofurzfcywain.supabase.co
  Esquema versionado en `supabase/001…` — 9 tablas, RLS en todas.
  Al 18/09/2026: **41 despachos, todos escritos por Claude**, del 23/07
  al 18/09 — el único día hábil que falta es el 17/08, feriado sin
  edición. 1222 normas · 85 movimientos · 690 páginas · 17 MB de 500.

Repo: https://github.com/orwellianoeyes/despacho-cordoba
App:  https://orwellianoeyes.github.io/despacho-cordoba/
Carpeta local: ~/despacho-cordoba

## Decisiones de diseño importantes (no deshacer sin razón)

- **El motor corre en la Mac de Leo, no en GitHub Actions.** El sitio
  del Boletín (boletinoficial.cba.gov.ar) bloquea con 403 los pedidos
  que vienen de servidores en la nube, pero no los que vienen de una IP
  hogareña. El workflow de GitHub Actions existe en el repo pero está
  **deshabilitado a propósito** — no reactivar salvo que se consiga
  acceso institucional al Boletín.

  **Reverificado el 17/09/2026** con la URL exacta del motor
  (`.../2026/09/1_Secc_160926.pdf`): desde una IP de datacenter, 403;
  desde la casa de Leo, 200 y el PDF entero. No es folclore viejo. Y la
  URL directa del PDF ya existía cuando se probó Actions en julio, así
  que el 403 se midió contra esta misma estrategia.

  Corolario que importa para el futuro: el 403 ata el sistema a **una IP
  hogareña, no a esa Mac**. Cualquier máquina en una casa sirve. Por eso
  el plan es achicar el papel de la Mac a un "buzón" que baja los PDFs y
  empuja el texto, no sacarla.
- **El disparo es MANUAL desde el 17/09/2026, por decisión de Leo.**
  launchd quedó desactivado con `launchctl disable gui/502/com.leo.despacho`.
  Reactivar solo si él lo pide, con `enable` + `bootstrap`.

  Ojo con el modo de apagarlo, que ya confundió una vez: en agosto Leo
  lo frenó con `bootout` (o desde la interfaz) porque tenía poco
  crédito, y **el 14/09 volvió a correr solo**. No fue un misterio:
  `bootout` descarga la tarea hasta el próximo inicio de sesión, y la
  Mac se reinició el viernes 11 a la noche; al abrir sesión, launchd
  recargó todo lo que hay en `~/Library/LaunchAgents`. Por eso se
  perdieron el 8, 9, 10 y 11 de septiembre. **`bootout` es temporal;
  `disable` es el que persiste al reinicio.**

- **El `.plist` del repo estaba roto y el instalado no.** Tenía una
  barra suelta después de `</string>` que hacía fallar `plutil -lint`.
  Arreglado el 18/09/2026. Si alguna vez se reinstala copiando desde el
  repo, validar primero con `plutil -lint com.leo.despacho.plist`.
- **El primer usuario que se registra se queda con el panel.** Las
  políticas RLS solo dejan leer a quien esté en `usuarios`, pero para
  agregarse habría que poder escribir: huevo y gallina. Lo resuelve el
  trigger `bootstrap_primer_usuario()` — si la tabla está vacía, el
  primero que entra queda como dueño; después ya no está vacía y nadie
  más entra solo. **Después del primer login conviene apagar los
  registros públicos** en Authentication → Sign In / Providers.

- **Sin crédito, la respuesta es `--sin-ia`, no Gemini** (decidido el
  18/09/2026). Baja, extrae y archiva el texto sin llamar a ninguna IA.
  El día queda a salvo por nada y se analiza bien cuando haya crédito,
  con `--rehacer`. Como el disparo es manual y nadie espera en la
  puerta, esto es estrictamente mejor que sacar un despacho flojo.

  `--sin-ia` no se frena si el despacho de ese día ya existe: sirve
  también para sumar al archivo una sección que no se había bajado. Y
  la guardia de `LIMITE_CARACTERES` no aplica, porque protege la
  llamada a la IA y acá no hay ninguna.

- **El respaldo automático está APAGADO** (`MOTOR_RESPALDO = None`).
  Gemini es de última instancia y solo entra si se lo pide a mano con
  `--motor gemini`. La maquinaria del respaldo está escrita y probada;
  para reactivarla alcanza con poner `"gemini"` en esa constante. La
  razón de tenerla apagada: si entrara sola, un día sin crédito saldría
  flojo sin que nadie lo hubiera decidido.

- **Claude primario, Gemini de última instancia — a propósito.**
  Al revés que en `~/app sentiment`, donde Gemini va de primario porque
  clasificar sentimiento es tarea simple. Acá es análisis jurídico fino:
  es donde la diferencia de calidad se nota y es lo que se le ofrece al
  cliente. El respaldo existe para un caso concreto que ya pasó —
  quedarse sin crédito y no poder sacar el despacho— no para los
  timeouts (si el problema es la conexión de casa, Gemini falla igual).

  Dos reglas que van con esto: el motor usado se guarda en el campo
  `motor` del JSON, y si salió el suplente **el aviso de Telegram lo
  dice en la primera línea**. Un respaldo silencioso es peor que no
  tener respaldo: la calidad baja sin que nadie se entere.

  **Probado contra un boletín real el 18/09/2026 (B.O. 182).** Gemini
  respeta la estructura —dígitos de sección, dos párrafos por síntesis,
  las cuatro miradas, JSON válido— pero la calidad baja bastante:

      ampliada.juridica   469 car (Claude)  ->  265 (Gemini)
      texto_oficial       982 car (Claude)  ->  306 (Gemini)
      indice_nuevas        51 entradas      ->   17

  Y se contradice: el aviso decía "35 normas" con 17 indexadas (en otra
  corrida, "53"). El `texto_oficial` deja de ser transcripción y pasa a
  ser resumen con puntos suspensivos, que para un despacho jurídico no
  sirve. **Conclusión: Gemini alcanza para que el día no quede vacío,
  no para mandarle el resumen a un cliente.** Un día escrito por Gemini
  queda además con un índice pobre, que es la columna vertebral del
  buscador: conviene rehacerlo con Claude cuando haya crédito.

  También metió un `- ` de lista de markdown en medio del JSON pese al
  `responseMimeType: application/json`. Por eso el parseo va dentro del
  intento y un JSON roto se reintenta con el mismo motor antes de pasar
  al respaldo.

- **El campo `seccion` en el JSON debe ser el dígito pelado** ("1",
  "4"), nunca texto como "Licitaciones (Sección 4)". Hubo un bug donde
  la IA devolvía texto largo y `_url_de_seccion()` fallaba en resolver
  la URL correcta (mandaba todo a Sección 1). Se arregló el regex
  (`re.search(r"[1-5]", ...)`) Y se reforzó en `instrucciones.md`. Si
  vuelve a pasar, revisar los dos lados.
- **SECCIONES = ["1", "4"]** por defecto — Legislación y Licitaciones.
  Es intencional (menos costo, más relevancia para trabajo legislativo).
  Ninguna sección es obligatoria: puede publicarse una sin la otra.
  Desde el 18/09/2026 se elige por corrida con `--secciones`.

  **No entran las cinco en una sola llamada.** Medición real del
  16/09/2026, en caracteres de texto extraído:

      secc. 1 Legislación      4 mil
      secc. 2 Judiciales     484 mil   ← 60 páginas de edictos
      secc. 3 Sociedades     331 mil
      secc. 4 Licitaciones   100 mil
      secc. 5 Varios          67 mil
      las cinco              985 mil   ≈ 250 mil tokens

  La ventana de Claude son 200 mil tokens e incluye la respuesta. O sea
  que 1+3+4+5 (~503 mil caracteres) entra, y lo único que revienta el
  tope es sumar la 2ª. `LIMITE_CARACTERES` corta antes de gastar la
  llamada y dice qué sacar. Si algún día hace falta la 2ª, hay que
  partir el análisis en una llamada por sección y unir los resultados
  —no es un flag, es un cambio de arquitectura del motor.

- **La subida a Supabase NO puede tumbar la corrida.** Los archivos de
  `docs/data/` y `texto/` se escriben primero y son el respaldo en git;
  la base es lo que lee el panel. Si la base no contesta, `_a_la_base()`
  avisa fuerte y sigue: perder la subida es recuperable con
  `migrar_a_supabase.py`, perder el despacho del día no.

## El emparejamiento va por significado, no por palabra (19/09/2026)

Lo que decide qué recibe cada cliente **ya no es** `plainto_tsquery`.
Medido sobre las 1.173 normas archivadas de las secciones 1 y 4:

    tema escrito     queda como      pega
    obra             'obra'           111
    obras            'obras'           86
    designaciones    'design'          87
    designacion      'designacion'     67
    licitaciones     'licit'          577
    licitacion       'licitacion'     574

El stemmer español reduce unos plurales y otros no, **sin regla que se
pueda aprender**. Y las listas no se contienen: 69 normas pegan con
"obra" y NO con "obras"; la unión son 155. El encargo real decía
"obras", así que el cliente veía **86 de 155 — el 45% invisible por
haber escrito el plural**.

Aun con el plural correcto quedaba afuera todo lo que no comparte
palabra: "Pavimento Modular Completo Zona 1", "Mantenimiento y
Reparación de Puentes en Red Vial Pavimentada", y "Construcción Nuevo
Edificio Hospital de Oliva" — esta última para alguien que pidió salud
**y** obras.

Peor que la pérdida: `calibrar_tema()` contaba con la MISMA consulta, así
que **confirmaba el tema con el mismo error** que después le hacía perder
las normas.

Ahora juzga Jev (TypeSafe) en `panel/lib/jev.ts`. Tres cosas que no hay
que deshacer:

- **Corre del lado de la aplicación, no en Postgres.** Supabase no permite
  instalar extensiones propias, así que no hay `WHERE` semántico dentro
  del motor. El resultado es el mismo; el lugar de ejecución no.
- **Se guardan TODAS las normas evaluadas con su probabilidad**, no solo
  las que superan el umbral (tabla `coincidencias`). Por eso mover el
  umbral es un filtro de lectura que no vuelve a gastar inferencia, y por
  eso se puede distinguir "no le toca nada" de "todavía no se miró".
- **Se calcula una vez por (encargo, edición).** Abrir el panel diez veces
  no cuesta diez veces. Sin caché, el costo escalaría con las veces que
  mira la pantalla, que es lo peor que puede pasarle a un gasto.

`encargos.umbral` es la perilla ancho/angosto, y se elige por la intención
(campaña 0,5 · normal 0,7 · angosta 0,85), nunca mostrando el número
pelado. Y las normas van **ordenadas por probabilidad, no por página**: en
titulares entran ~15 y el celular lee las tres primeras.

Límites reales del modelo (docs.typesafe.ai/models, verificados el
19/09/2026): 64k tokens por request, 32k para el state más la pregunta más
larga, entrada a USD 0,042 por millón y **la salida no se cobra**.

**UNA norma por request, medido el 22/09/2026 y no supuesto.** Sobre las
23 normas del 18/09 con el encargo real:

                                  requests   tokens   entran   USD
      lote de 20                         2   19.530     7/23   0,0008
      de a una                          23   26.099     9/23   0,0011
      de a una + texto de la página     23   51.811    14/23   0,0022

Agrupar ahorraba poquísimo —lo que domina el costo es el texto de las
preguntas, no el state— y **diluía el juicio**: "Mantenimiento Puentes Red
Vial Pavimentada Provincial" saca 0,66 en lote y 0,89 sola. Es obra vial y
tiene que llegarle a quien pidió "obras"; en lote quedaba afuera.

**Sumarle el texto de la página fue peor, no mejor, y eso NO es intuitivo.**
El crudo ya está archivado y pago, así que parecía gratis. Pero una página
del Boletín contiene VARIAS normas, y el modelo le atribuye a una lo que
dice la de al lado: "Adquisición Tarjetas Electrónicas Speed Tronic" pasó
de 0,09 a 0,83 y los cables de EPEC de 0,23 a 0,80 — entraban 14 de 23,
media edición. No reintentarlo sin resolver antes el recorte por norma,
que hoy no existe.

La nota es **estable**: dos corridas idénticas dieron desvío medio 0,012 y
ningún cambio de lado del umbral. Lo que mueve la nota es con quién viaja
la norma, no el azar.

**El criterio de qué entra vive en `panel/lib/criterio-tema.md`**, como los
otros tres instructivos. Se ganó el lugar el 22/09/2026: Leo dictó que un
gasto para modificar una estructura o un mecanismo interno de una obra
cuenta como obra. Agregar eso —y decir explícitamente que comprar insumos
NO cuenta— movió diez notas y **agrandó la separación en vez de achicarla**:

    Aumento Disponibilidad Potencia Complejo Hidroeléctrico  0,62 → 0,79  entra
    Adquisición Indumentaria Técnica Laboral EPEC            0,40 → 0,06
    Cargador Vehículos Eléctricos EPEC                       0,36 → 0,29
    Adquisición Cables Baja Tensión EPEC                     0,17 → 0,09
    Adquisición Repuestos RTU G100 EPEC                      0,10 → 0,06

Quedan 10 de 23, con la más baja que entra en 0,78 y la más alta que queda
afuera en 0,51: un colchón de 27 puntos alrededor del umbral. Nombrar lo
que NO cuenta resultó más potente que nombrar lo que sí.

## Dos listas de temas que NO hay que mezclar

- `instrucciones.md` → **TEMAS VIGILADOS**: los de Leo. El motor los usa
  para elegir cuáles de las ~45 normas del día merecen análisis completo
  (entre 3 y 10). Son su criterio editorial.
- `encargos.temas` en Supabase: los de cada cliente. Deciden **a quién le
  llega qué**, no qué se analiza.

**Analizado y decidido el 18/09/2026: no se unifican.** El argumento a
favor era el costo: una norma que matchea a un cliente pero que el motor
no destacó hay que resumirla aparte. Medido sobre 9 ediciones y un
encargo real: de 58 normas, 36 venían gratis y 22 no — 2,4 clics por día
y 13 centavos en nueve días. **El problema eran los clics, no la plata**,
y se resolvió con el botón de resumir en lote.

Las razones para NO mezclarlas, en orden de peso: el criterio de Leo es
el producto (si lo fija la cartera, las destacadas pierden su valor); el
archivo dejaría de ser comparable en el tiempo por razones comerciales;
rompería el principio del cerebro editable (el instructivo pasaría a ser
una plantilla armada desde la base); y hay 3-10 lugares por día para los
que competirían todos los temas de todos los clientes.

Si algún día muchos clientes piden un tema que no está, **Leo lo agrega a
mano** mirando el mercado. Revisión humana periódica, nunca sincronización
automática.

### La palanca no es quién elige, es cuántas (medido el 22/09/2026)

Vuelve a aparecer el argumento de costo, ahora con un dato nuevo: que el
motor destaque una norma sale **más barato** que resumirla a pedido.
Medido sobre el 18/09 —101.059 caracteres de entrada, 22.578 de salida,
9 destacadas—, a ~3,5 caracteres por token:

    destacarla en el despacho diario   0,36 ¢   (solo salida: la entrada ya está)
    resumirla a pedido desde el panel  0,61 ¢   (hay que remandar la página)

Tentador, pero **la conclusión NO es acoplar los encargos al instructivo**.
La entrada es fija —el boletín entero se manda igual, tenga 3 destacadas o
15— así que lo único que crece es la salida, y el ahorro real medido con un
cliente es **un centavo por edición, veintidós al mes**. No paga lo que
cuesta del otro lado.

Lo que SÍ sale de ahí es otra palanca, que no acopla nada:
`instrucciones.md:79` dice **"Cuántas: entre 3 y 10 por día ← rango
ajustable"**. Subir ese número compra más análisis al precio barato sin
tocar quién decide, sin que el motor dependa de Supabase y sin romper la
comparabilidad del archivo.

**El punto de equilibrio es 8 normas por edición:**

    destacar las 14 no destacadas   14 × 0,36 ¢ = 5,0 ¢
    5,0 ¢ ÷ 0,61 ¢                  = 8,2 normas

Si entre todos los clientes se piden **más de 8 normas distintas por
edición** que el motor no destacó, conviene subir el rango. Menos de 8,
conviene dejarlo: con un solo cliente fueron 4, y destacar todo habría
perdido 2,6 ¢ por edición pagando análisis que nadie lee.

La forma de medirlo no es teórica: el panel avisa solo cuando el promedio
pasa de 8.

## Trampas de datos que ya costaron tiempo

- **Las dos listas del JSON nombran distinto a la misma norma.** El
  despacho trae `normas` (destacadas, con análisis) e `indice_nuevas`
  (todas, solo metadatos). Solo el **18%** coincide palabra por palabra.
  Emparejar además por el número —los dígitos sueltos, y SOLO cuando
  hay un único candidato— lleva la cobertura al 95%. Está en
  `_emparejar()`. Sin eso, importar crea dos filas por norma.

- **PostgREST exige que todas las filas de un lote tengan exactamente
  las mismas claves** ("All object keys must match"). Las del índice no
  traen análisis, así que hay que completarlas con null antes de subir.

- **`.gitignore` con `.env` a secas NO cubre `.env.respaldo`.** Pasó el
  18/09/2026: al reparar una clave mal pegada quedó un respaldo con la
  credencial afuera del ignore. Ahora está `.env.*` con excepción para
  `.env.example`.

## Problemas ya resueltos (no repetir el diagnóstico)

- **El `read operation timed out` NO era la API: era la conexión.**
  Medido el 18/09/2026 con el cronómetro, nueve llamadas seguidas sin una
  sola falla:

      43 mil caracteres →  87 s      144 mil → 81 s y 91 s
      32 mil           →  78 s      148 mil → 125 s
      101 mil          → 111 s      159 mil →  82 s
      118 mil          → 114 s      180 mil →  94 s

  **Ninguna pasó de 125 segundos**, y el timeout del cliente está en 600:
  nunca estuvo ni cerca de dispararse. Tampoco hay correlación con el
  tamaño (159 mil caracteres en 82 s, 148 mil en 125 s). Las 17 fallas
  históricas eran cortes de red del lado de casa, no la API tardando.
  No subir `TIMEOUT_IA` ni cambiar de modelo buscando arreglar esto: si
  reaparece, mirar la conexión.

- **La IA devuelve JSON roto ~1 de cada 3 veces, y se arregla sola.**
  Medido en las mismas nueve llamadas: dos volvieron malformadas (una a
  los 21 mil caracteres, con el JSON completo pero un error de sintaxis
  en el medio) y el reintento del mismo motor resolvió las dos. Por eso
  el parseo va DENTRO del intento y `INTENTOS_POR_MOTOR = 2`. Es un
  tropiezo aleatorio del modelo: volver a tirar los dados alcanza.

- **El número de página puede venir como rango.** La IA escribió
  `"5-14"` para un edicto que abarcaba de la página 5 a la 14 — razonable,
  pero la columna de la base es un entero y el ancla del PDF también, así
  que Supabase rechazó la subida ENTERA con
  `invalid input syntax for type integer`. `normalizar_paginas()` se llama
  apenas vuelve la API y deja el primer número, que es donde la norma
  empieza. Hay una defensa igual en `datos.py` para los archivos viejos.

- **Regenerar un día duplicaba en Supabase.** El upsert va contra
  (fecha, tipo, numero, titulo) y el motor nuevo escribe los títulos
  distinto —siempre—, así que las filas viejas quedaban huérfanas
  conviviendo con las nuevas. `_limpiar_dia()` borra primero, igual que
  hace `guardar()` con indice.json. **Preserva las normas con análisis
  extenso**: eso se pidió a mano y se pagó aparte.

- **El SDK exige streaming** cuando `max_tokens` es alto: con `.create()`
  tiraba "Streaming is required for operations that may take longer than
  10 minutes". Resuelto usando `cliente.messages.stream(...)`. Eso sí
  está cerrado. Lo que NO está cerrado es el timeout recurrente: ver
  "Pendiente" más abajo — el diagnóstico viejo ("boletines grandes") no
  coincide con los datos.
- **Credenciales de git pidiendo el llavero de macOS en corridas
  automáticas**: causado por tener DOS `credential.helper` configurados
  a la vez (`osxkeychain` en `/usr/local/git/etc/gitconfig` a nivel
  sistema, `store` en `~/.gitconfig` a nivel usuario). git probaba el
  del sistema primero y trababa la corrida sin nadie para autorizar.
  Arreglado con `sudo git config --system --unset-all credential.helper`.
  Si reaparece el cartel del llavero, revisar con
  `git config --list --show-origin | grep credential` — debe aparecer
  SOLO `store`.
- **El número NO identifica una norma. Nunca deduplicar por
  (fecha, número).** En el Boletín una edición trae doce edictos
  distintos todos con `numero: "s/n"`, notificaciones distintas con
  `numero: "Juzgado Electoral"`, y notas aclaratorias con `numero: "1"`.
  Los 14 pares "repetidos" que aparecían en `indice.json` se revisaron
  uno por uno el 18/09/2026: **los 14 eran normas diferentes, ninguno
  era una copia.** Un dedup por (fecha, número) habría borrado once
  edictos reales del 04/09. La clave correcta está en `_clave_indice()`
  e incluye el título, que sí distingue. Probado regenerando el 04/09:
  los doce "s/n" sobreviven.

- **Regenerar un día limpia primero su rastro en el índice.** Sin eso,
  `--rehacer` (o cambiar de motor) dejaba mezcladas las entradas de las
  dos corridas.

- **Restos de la demo sobre datos reales** (resuelto el 18/09/2026).
  El cartel "Texto de ejemplo…" y los tooltips "Demo:" estaban fijos en
  la plantilla, sin depender de `MODO`, así que el sitio publicado le
  decía al lector que el articulado oficial era inventado —8 veces por
  edición—. Ahora cuelgan de `MODO`; el helper `tituloPDF()` hace lo
  mismo con los tooltips. De paso: el pie ya no dice "GitHub Actions",
  la barra no promete correo (que no está configurado) y la barra
  muestra **qué motor escribió el despacho**, en rojo si no fue el
  titular. Probado en los dos modos.

- **Alucinaciones de la IA** (inventaba vínculos entre organismos y
  proyectos que el texto no mencionaba — ej. le puso la Ruta Porteña-
  Freyre a una licitación de CASISA que no la mencionaba): resuelto en
  `instrucciones.md` con (a) regla de anclaje textual explícita, (b) un
  glosario de competencias reales de organismos provinciales (CASISA
  solo maneja la RAC, no rutas provinciales; distinción clave), (c) que
  los "temas vigilados" se marquen como hipótesis del analista, no como
  hecho, en el campo `importa`.
- **GitHub Pages no republicaba tras cambiar el username de GitHub**
  (de LeoBurgos23 a orwellianoeyes): Pages quedó "desenganchado". Se
  destrabó con el truco de cambiar Source→branch folder a otro valor,
  guardar, y volver a `/docs`, guardar de nuevo. Si la app muestra un
  despacho viejo pese a que `git log` confirma que el nuevo se publicó,
  sospechar esto primero — verificar con
  `curl -s https://orwellianoeyes.github.io/despacho-cordoba/data/ultimo.json`
  contra lo que hay en el repo.

## Pendiente / conocido, no resuelto

- El `.env` con las claves vive solo en la Mac de Leo, nunca en el
  repo (está en `.gitignore`); los nombres de las variables sí están
  documentados en `.env.example`. **Es lo único del sistema que no
  existe fuera de esa Mac.** Si alguna vez falta, avisar — no regenerar
  claves sin que él lo pida explícitamente.

## Hacia dónde va (decidido el 17/09/2026)

Despacho deja de ser solo el resumen personal de Leo y pasa a ofrecerse
a asesores legislativos y candidatos. La forma elegida es **concierge,
no SaaS**:

- Un único panel, el de Leo. **No hay cuentas ni paneles por cliente.**
- Los clientes son IDs de Telegram sumados a su bot. El pedido lo lee
  Leo y lo carga en el panel; el bot solo **recibe y acusa recibo**
  (ver "El bot recibe" más abajo).
- El encargo queda vivo día a día, pero **nada sale sin que Leo lo
  despache**. Preparar es automático; enviar es manual.
- Al cliente le llega solo su resumen con las cuatro miradas.
  **Nunca el link al panel.** Si pide más, Leo le manda un documento.

El porqué: eliminar la promesa operativa. Si el envío dependiera de que
la Mac esté abierta, un candidato en campaña quedaría colgado. Con el
envío manual, un día que no salió no le falla a nadie. Y evita construir
auth, RLS y facturación antes de saber si alguien paga.

Ante cualquier propuesta de automatizar el envío, multiplicar paneles o
dar acceso a clientes: frenar y confirmar. **El cuello de botella es Leo
a propósito.** El molde técnico de referencia es su propio `~/bot de X`
(Supabase + panel en Vercel + webhook de Telegram), no una arquitectura
nueva.

Cómo funciona el envío, que es el corazón del producto:

- `contactos` + `encargos`: cada cliente tiene uno o más encargos, con un
  nombre, los temas que pidió vigilar y qué secciones mirar.
- `normas_del_encargo()` lee de `coincidencias` y devuelve **qué tema hizo
  entrar cada norma** y con qué probabilidad, para poder mostrarlo y
  ordenar por eso. Quien llena `coincidencias` es `/api/emparejar`, con
  Jev — ver la sección del emparejamiento por significado más arriba.
- `/api/calibrar` dice cuánto pegaría un tema ANTES de guardarlo.
  Nació de medir que "licitacion" matchea 14 normas por edición —media
  Sección 4— mientras "paritaria docente" pega 3 veces en dos meses. Sin
  ese número no hay forma de saber si se le está por mandar al cliente un
  goteo o una avalancha. Desde el 19/09/2026 juzga una muestra de las
  últimas 10 ediciones y **devuelve los títulos que pegaron**: el número
  dice cuántas, los títulos dicen si son las que él esperaba.
- El panel prepara y **Leo despacha**: el botón de enviar está deshabilitado
  hasta haber visto la vista previa, que además **se puede editar** — lo
  que sale lleva su firma, no la del sistema. El mensaje al cliente **no
  lleva link al panel** ni menciona la herramienta.

- **Cuatro formatos, una escalera.** Telegram corta en 4096 caracteres y
  el celular corta antes: la atención. Medido sobre las 335 normas
  analizadas:

      titulares  240 car/norma  →  entran ~15  (qué salió, monto y fecha)
      breve      512            →  entran ~8   (y de qué se trata)
      completo  1652            →  entran ~2,5 (las cuatro miradas)
      extenso   ~9000           →  de a una

  **El diario va en titulares, que es el que Leo pidió después de leer
  uno en el celular.** El título ya dice de qué se trata; lo que falta es
  la plata y la fecha de apertura, que se extraen de `importa` con dos
  expresiones regulares. Un mensaje de 2 normas pasó de 1312 a 474
  caracteres sin perder nada accionable.

  El camino completo: a la mañana van los titulares, el cliente pide una,
  se destilda el resto y se manda esa sola en completo o extenso. Mismo
  flujo, sin pantallas nuevas.
- `entregas` guarda el texto que REALMENTE salió, no el que se armaría
  hoy: el análisis puede cambiar después y hay que saber qué leyó.

### El bot recibe (23/09/2026)

El panel está en Vercel (`despacho-panel.vercel.app`, proyecto
`despacho-panel`, se despliega solo desde `main`). Con eso el bot pasó a
webhook: Telegram avisa cada mensaje a `/api/telegram/webhook`, que lo
guarda en `mensajes_telegram`. Lo que contesta solo son DOS textos fijos,
a quien todavía no está vinculado: al primer mensaje un saludo que pide
los temas, al segundo un acuse. Después, silencio. Dice "quedaste
anotado", no "estás adentro": adentro queda cuando Leo lo vincula.

- **Los temas que escribe el cliente se leen, no se cargan solos**
  (decisión de Leo). Aparecen en Contactos → Vincular Telegram, y el
  encargo lo arma él. No cuesta nada: no pasa por ninguna IA.
- **El webhook no usa la service_role.** Entra por `recibir_telegram()`,
  una SECURITY DEFINER abierta a anon pero cerrada con el secreto que
  Telegram manda en cada aviso. El secreto lo genera el botón "Conectar el
  bot" y vive en la tabla `bot`, que anon no puede leer.
- Con webhook, `getUpdates` deja de funcionar: por eso Vincular lee de la
  base. Se terminó el límite de las 24 horas.
- Si Telegram no llega, Vincular muestra el error que ve Telegram
  (`getWebhookInfo`). Es la forma de saber si la protección de despliegue
  de Vercel lo está frenando.
- **El aviso "tu tema aparece poco" NO sale solo.** Cuando calibrar da
  menos de 0,3 por edición, el panel ofrece un borrador editable y lo manda
  Leo. Queda en `entregas` sin normas, para que figure en el historial.

Etapas pendientes: documento para el cliente que pide algo más completo.

## Cómo trabaja Leo (importante para el tono y el método)

- Es abogado y asesor legislativo. Prefiere explicaciones técnicas
  simples, por partes, con analogías. Pide "explicame de manera
  sencilla" cuando algo no queda claro — dar esa explicación sin que
  se sienta que se lo trata de menos.
- **Nunca inventar ni asumir sin decirlo.** Él va a verificar todo por
  su cuenta o con sus propios estudios. Si algo no se puede confirmar
  con los datos disponibles (código real, log real, doc real), decirlo
  explícitamente en vez de dar una respuesta plausible.
- Antes de sugerir un cambio de código, preferir verificar contra el
  código y los datos REALES del repo/logs, no contra lo que "debería"
  ser. Ya pasó más de una vez que una recomendación sonaba razonable
  pero no coincidía con el comportamiento real del sistema.
- Prefiere el cambio mínimo que resuelve el problema, no la solución
  más completa técnicamente posible. Explícitamente pidió no
  sobrecargar el código ni el instructivo con reglas que no atacan una
  causa real.
- Antes de aplicar un cambio, mostrarle el diff (`git diff`) para que
  lo revise él mismo. Es su método de trabajo, no un paso opcional.
