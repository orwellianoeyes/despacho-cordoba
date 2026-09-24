-- Dos acuses, porque hay dos preguntas distintas.
--
-- El mensaje que recibe el cliente termina con "¿Querés el análisis de
-- alguna? Avisame." Si contesta "sí, la del hospital", el bot le decía:
--
--     "Lo reviso y, si hay algo sobre eso en el Boletín, te lo mando."
--
-- Que no tiene sentido: la norma está en el mensaje que está leyendo. Hay
-- algo, se lo acaban de mandar. Lo marcó Leo el 24/09/2026.
--
-- Distinguirlo por el texto es imposible —"la segunda", "la del hospital",
-- "ese decreto" son infinitas formas— pero sí se puede por contexto: si se
-- le mandó una entrega en las últimas 24 horas, lo más probable es que
-- esté contestando eso.
--
--     con entrega reciente   pedido_del_resumen   "Dale. Veo cuál es y te
--                                                  la mando con el análisis."
--     sin entrega reciente   pedido               "Lo reviso y, si hay algo
--                                                  sobre eso, te lo mando."
--
-- El primero compromete el envío porque la norma existe; el segundo no,
-- porque puede no existir. Es una heurística, no una certeza: si se
-- equivoca, el peor caso es un "veo cuál es" sobre algo que no estaba en
-- la entrega — y Leo lo ve igual en la bandeja.
--
-- La función entera quedó aplicada en la base; acá está el bloque nuevo:
--
--   select exists (
--     select 1 from entregas g
--     join contactos c on c.id = g.contacto_id
--     where c.telegram_id = p_chat_id and g.estado = 'enviada'
--       and g.enviada_en > now() - interval '24 hours'
--   ) into v_reciente;
--   return query select (case when v_reciente then 'pedido_del_resumen'
--                             else 'pedido' end)::text, null::text;

-- La bandeja dice cuál es cuál: sin eso, "mandame la del hospital" no
-- dice a qué hospital, porque falta saber si contesta algo que recibió.
drop function if exists mensajes_de_clientes();
create function mensajes_de_clientes()
returns table (update_id bigint, chat_id bigint, contacto_id bigint,
               contacto text, texto text, recibido_en timestamptz,
               tras_entrega boolean)
language sql stable security invoker
set search_path = public, pg_temp as $$
  select m.update_id, m.chat_id, c.id, c.nombre, m.texto, m.recibido_en,
         exists (select 1 from entregas g
                  where g.contacto_id = c.id and g.estado = 'enviada'
                    and g.enviada_en between m.recibido_en - interval '24 hours'
                                         and m.recibido_en)
  from mensajes_telegram m
  join contactos c on c.telegram_id = m.chat_id
  where m.atendido_en is null
  order by m.recibido_en desc
  limit 50;
$$;
comment on function mensajes_de_clientes is
  'Bandeja de pedidos. tras_entrega dice si escribió después de recibir algo: cambia qué le contestó el bot y qué está preguntando.';
