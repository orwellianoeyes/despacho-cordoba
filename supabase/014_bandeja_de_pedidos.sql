-- El cliente ya adentro también recibe respuesta, y Leo ve lo que pide.
--
-- Hasta acá, un contacto ya aceptado que le escribía al bot recibía
-- SILENCIO: la función salía temprano con `return null`. Y su mensaje
-- quedaba guardado en un lugar que el panel no mira, porque la pantalla
-- de Vincular solo lee los chats todavía SIN vincular.
--
-- Se vio en vivo el 23/09/2026: Belén, recién aceptada, escribió "Mira el
-- boletín oficial, informame de los anuncios que salen en la última
-- publicación" y no recibió nada. El mensaje existía en la base y no
-- aparecía en ninguna pantalla.
--
-- Dos arreglos que van juntos y no sirven separados:
--   · el bot acusa recibo — sin prometer que hay algo, porque eso lo
--     decide Leo mirando la edición;
--   · el pedido aparece en una bandeja del panel.
-- Acusar sin lo segundo sería mentirle al cliente.

alter table mensajes_telegram add column acuse_en    timestamptz;
alter table mensajes_telegram add column atendido_en timestamptz;

comment on column mensajes_telegram.acuse_en is
  'Cuándo el bot le dijo "lo reviso". Sirve de freno: una ráfaga de tres mensajes recibe un solo acuse.';
comment on column mensajes_telegram.atendido_en is
  'Cuándo Leo lo dio por resuelto en el panel. Null = sigue en la bandeja.';

create index mensajes_telegram_pendientes
  on mensajes_telegram (recibido_en desc) where atendido_en is null;

-- La función entera está en la migración aplicada; acá queda solo el
-- bloque que cambió, para que se lea el porqué sin releer las 60 líneas.
--
--   if exists (select 1 from contactos c where c.telegram_id = p_chat_id) then
--     if exists (select 1 from mensajes_telegram m          -- un acuse por ráfaga
--                 where m.chat_id = p_chat_id
--                   and m.acuse_en > now() - interval '15 minutes') then
--       return query select null::text, null::text; return;
--     end if;
--     update mensajes_telegram set acuse_en = now() where update_id = p_update_id;
--     return query select 'pedido'::text, null::text; return;
--   end if;

-- La bandeja: lo que escribieron los clientes YA vinculados y Leo todavía
-- no resolvió. Los que no están vinculados se ven en Vincular, que es otra
-- pantalla y otro momento.
create or replace function mensajes_de_clientes()
returns table (update_id bigint, chat_id bigint, contacto_id bigint,
               contacto text, texto text, recibido_en timestamptz)
language sql stable security invoker
set search_path = public, pg_temp as $$
  select m.update_id, m.chat_id, c.id, c.nombre, m.texto, m.recibido_en
  from mensajes_telegram m
  join contactos c on c.telegram_id = m.chat_id
  where m.atendido_en is null
  order by m.recibido_en desc
  limit 50;
$$;
comment on function mensajes_de_clientes is
  'Bandeja de pedidos: lo que escribió un cliente ya vinculado y sigue sin resolver.';
