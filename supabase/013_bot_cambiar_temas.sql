-- El cliente puede corregir sus temas antes de que Leo lo acepte.
--
-- Por qué. La 012 decidía qué contestar contando mensajes: al primero el
-- saludo, al segundo el acuse, después silencio. Si el cliente escribía
-- "me equivoqué", nadie le contestaba y Leo veía dos listas de temas sin
-- saber cuál valía. Ahora cada chat tiene una ficha con el paso en que
-- está y los temas vigentes, y el anterior queda a la vista si cambió.
--
-- Dónde vive cada cosa: el TEXTO lo interpreta el panel (si es /start, si
-- pide cambiar) y las RESPUESTAS también, en panel/lib/bot-textos.ts. Acá
-- solo vive el estado, para que dos mensajes seguidos no se pisen.

create table chats_telegram (
  chat_id          bigint primary key,
  nombre           text,
  usuario          text,
  estado           text not null default 'pidiendo_temas'
                     check (estado in ('pidiendo_temas', 'con_temas')),
  temas            text,         -- lo último que mandó como temas
  temas_anteriores text,         -- lo que había antes de pedir cambiarlos
  actualizado_en   timestamptz not null default now()
);
comment on table chats_telegram is
  'En qué paso está cada persona que le escribió al bot, y qué temas pidió. '
  'Se lee en Contactos; el encargo lo arma Leo a mano.';

alter table chats_telegram enable row level security;
create policy panel_todo on chats_telegram for all to authenticated
  using      ((select exists (select 1 from usuarios u where u.id = auth.uid())))
  with check ((select exists (select 1 from usuarios u where u.id = auth.uid())));

-- Los que ya escribieron con la 012 no vuelven a recibir el saludo: si
-- mandaron algo además del /start, eso se toma como sus temas.
insert into chats_telegram (chat_id, nombre, usuario, estado, temas, actualizado_en)
select m.chat_id, max(m.nombre), max(m.usuario),
       case when bool_or(m.texto <> '/start') then 'con_temas' else 'pidiendo_temas' end,
       (array_agg(m.texto order by m.recibido_en desc)
          filter (where m.texto <> '/start'))[1],
       max(m.recibido_en)
from mensajes_telegram m
group by m.chat_id;

-- Cambia lo que devuelve: ya no un conteo, sino QUÉ contestar. Hay que
-- borrarla primero porque Postgres no deja cambiar el tipo de retorno.
drop function recibir_telegram(text, bigint, bigint, text, text, text);

-- p_intencion la decide el panel mirando el texto:
--   'inicio'  el /start que manda Telegram al abrir el bot
--   'cambio'  pide cambiar los temas ("cambiar", "me equivoqué"...)
--   'texto'   cualquier otra cosa
-- Devuelve la acción ('saludo' | 'acuse' | 'repreguntar' | null = callar)
-- y, en el acuse, los temas anotados para repetírselos al cliente.
create function recibir_telegram(
  p_secreto text, p_update_id bigint, p_chat_id bigint,
  p_nombre text, p_usuario text, p_texto text, p_intencion text)
returns table (accion text, temas_anotados text)
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v       chats_telegram%rowtype;
  v_texto text := left(p_texto, 2000);
begin
  if p_secreto is null or not exists
       (select 1 from bot b where b.id = 1 and b.secreto = p_secreto) then
    raise exception 'secreto inválido' using errcode = '28000';
  end if;

  insert into mensajes_telegram (update_id, chat_id, nombre, usuario, texto)
  values (p_update_id, p_chat_id, left(p_nombre, 200), left(p_usuario, 100), v_texto)
  on conflict (update_id) do nothing;
  if not found then                       -- reintento de Telegram: ya se atendió
    return query select null::text, null::text; return;
  end if;

  -- Ya aceptado por Leo: el bot no le contesta nada automático.
  if exists (select 1 from contactos c where c.telegram_id = p_chat_id) then
    return query select null::text, null::text; return;
  end if;

  select * into v from chats_telegram where chat_id = p_chat_id for update;
  if not found then
    insert into chats_telegram (chat_id, nombre, usuario)
    values (p_chat_id, left(p_nombre, 200), left(p_usuario, 100));
    return query select 'saludo'::text, null::text; return;
  end if;

  if p_intencion = 'inicio' then
    return query select (case when v.estado = 'pidiendo_temas' then 'saludo' end)::text,
                        null::text;
    return;
  end if;

  -- Pedir cambio solo cuenta si ya había temas. Mientras se le están
  -- pidiendo, todo es tema: si no, "cambio climático" no entraría nunca.
  if p_intencion = 'cambio' and v.estado = 'con_temas' then
    update chats_telegram set estado = 'pidiendo_temas', actualizado_en = now()
    where chat_id = p_chat_id;
    return query select 'repreguntar'::text, null::text; return;
  end if;

  if v.estado = 'pidiendo_temas' then
    update chats_telegram
       set estado = 'con_temas', temas = v_texto,
           temas_anteriores = coalesce(v.temas, v.temas_anteriores),
           actualizado_en = now()
     where chat_id = p_chat_id;
    return query select 'acuse'::text, v_texto; return;
  end if;

  -- Ya mandó sus temas y escribe otra cosa: queda guardado, Leo lo lee.
  return query select null::text, null::text;
end $$;

-- Supabase le da EXECUTE a anon y authenticated por defecto a cada función
-- nueva: se le saca a authenticated, que no la necesita. El linter va a
-- seguir marcando la de anon, y está bien: es el único que la usa, y sin el
-- secreto no hace nada.
revoke all on function recibir_telegram(text, bigint, bigint, text, text, text, text) from public;
revoke execute on function recibir_telegram(text, bigint, bigint, text, text, text, text) from authenticated;
grant execute on function recibir_telegram(text, bigint, bigint, text, text, text, text) to anon;
comment on function recibir_telegram is
  'Única puerta del webhook de Telegram. Exige el secreto de la tabla bot.';
