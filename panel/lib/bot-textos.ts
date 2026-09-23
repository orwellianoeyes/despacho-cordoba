// Todo lo que el bot dice sin que Leo lo despache, en un solo lugar para
// poder corregirlo sin buscar. Es recepción, no análisis: ninguno de estos
// textos habla de normas ni evalúa nada.

// Al primer mensaje, o al /start mientras todavía no mandó temas.
export const SALUDO = (nombre: string) =>
  `Hola${nombre ? ` ${nombre}` : ""}. Ya quedaste anotado en el Despacho Diario `
  + `del Boletín Oficial de Córdoba.\n\n`
  + `Contame qué temas te interesa vigilar, separados por coma. `
  + `Por ejemplo: obra vial, salud, paritaria docente.`;

// Cuando manda los temas. Se los repite para que vea si se equivocó, y le
// dice cómo corregirlos. No lo deja esperando sin saber qué pasa.
export const ACUSE = (temas: string) =>
  `Listo, anoté estos temas:\n«${temas}»\n\n`
  + `Si te equivocaste o querés cambiar alguno, escribí CAMBIAR y me los `
  + `mandás de nuevo. Si están bien, no hace falta que hagas nada: en breve `
  + `te confirmo el alta por acá.`;

// Cuando pide cambiarlos.
export const REPREGUNTA =
  `Dale. Mandame de nuevo los temas que te interesa vigilar, separados por coma.`;

// Cuando Leo lo acepta en el panel. Es el cierre: recién acá está adentro.
export const CIERRE = (nombre: string) =>
  `Listo${nombre ? `, ${nombre}` : ""}: ya estás adentro. Cuando el Boletín `
  + `Oficial publique algo sobre tus temas, te llega por este mismo chat.`;

// Qué cuenta como "quiero cambiar mis temas". Solo se aplica si ya había
// mandado temas (lo decide la base): mientras se los está pidiendo, todo
// lo que escribe es tema, así "cambio climático" entra como tal.
export const PIDE_CAMBIO = /cambi|equivoc|correg|modific/i;
