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

## Problemas ya resueltos (no repetir el diagnóstico)

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

- **El timeout de la API NO está resuelto: falla 1 de cada 3 corridas.**
  17 de 53 llamadas cortaron con `The read operation timed out`. Siempre
  se salvó por el reintento de `correr.sh`, así que nunca se vio.
  El diagnóstico viejo ("boletines grandes") no explica los datos:
  **falló con 44 mil caracteres y anduvo con 227 mil**. Se comporta más
  como un corte de red del lado de casa que como un límite de la API,
  pero eso todavía NO está probado. Desde el 18/09/2026 la llamada está
  cronometrada y el log dice a los cuántos segundos cortó: con dos o
  tres corridas se distingue un corte de red (falla en segundos) de un
  timeout real del cliente (falla a los 600). **Mirar el log antes de
  proponer un arreglo.**

- **La app publicada muestra restos de la demo sobre datos reales.**
  En `docs/index.html:627` el cartel "Texto de ejemplo — en producción
  se extrae del PDF oficial del día" está fijo en la plantilla, sin
  depender de `MODO`, así que aparece debajo de cada texto oficial de
  verdad (8 veces el 16/09). Los botones "Abrir PDF oficial" tienen el
  tooltip "Demo:" aunque el link sea correcto. El pie dice "GitHub
  Actions" y la barra dice "Telegram + correo" aunque el correo no esté
  configurado. `index.html` no se toca desde el 03/08/2026.

- **Faltan 4 días hábiles: 8, 9, 10 y 11 de septiembre de 2026.** Los
  PDF siguen publicados y `--fecha` ya existe, así que son recuperables;
  quedó pendiente de que Leo cargue crédito. El texto crudo del 8 ya
  está archivado en `texto/`.

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
- Los clientes son IDs de Telegram sumados a su bot. El bot es de
  salida; el pedido entra por fuera y Leo lo carga en el panel.
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

Etapas pendientes: Supabase y migración · panel en Vercel con la libreta
de contactos · envío por Telegram + documento · buscador con resumen a
pedido (habilitado por `texto/`) · pedidos entrando por bot, más adelante.

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
