-- El bot deja de ser solo de salida: recibe, saluda y guarda lo que le
-- escriben.
--
-- Por qué. Hasta acá el panel le preguntaba a Telegram "¿quién escribió?"
-- con getUpdates, y Telegram descarta lo no leído a las 24 horas. Con el
-- webhook es al revés: Telegram avisa apenas llega un mensaje. Eso permite
-- contestar solo (saludo y pedido de temas) y que nada se pierda.
--
-- Lo que NO cambia: nadie queda adentro solo. El mensaje queda guardado,
-- Leo lo lee en Contactos y lo vincula a mano. Los temas que escribe el
-- cliente se leen, no se cargan solos: el encargo lo arma Leo.
--
-- El problema de la llave. El webhook llega sin sesión, y la service_role
-- NO va al panel (ver CLAUDE.md). Así que entra por una única función
-- SECURITY DEFINER, abierta a anon pero cerrada con un secreto: el mismo
-- que Telegram manda en cada aviso (X-Telegram-Bot-Api-Secret-Token). El
-- secreto lo genera el panel al conectar el bot y vive en la tabla `bot`,
-- que anon no puede leer. Sin el secreto, la función no escribe nada.

create table mensajes_telegram (
  update_id   bigint primary key,      -- Telegram reintenta: esto evita duplicados
  chat_id     bigint not null,
  nombre      text,
  usuario     text,
  texto       text,
  recibido_en timestamptz not null default now()
);
create index mensajes_telegram_chat on mensajes_telegram (chat_id, recibido_en desc);
comment on table mensajes_telegram is
  'Lo que la gente le escribe al bot. Se lee en Contactos; nada se procesa solo.';

create table bot (
  id             int primary key default 1 check (id = 1),
  secreto        text not null,
  actualizado_en timestamptz not null default now()
);
comment on table bot is
  'El secreto del webhook de Telegram. Una sola fila; la escribe el panel al conectar el bot.';

alter table mensajes_telegram enable row level security;
alter table bot               enable row level security;
create policy panel_todo on mensajes_telegram for all to authenticated
  using      ((select exists (select 1 from usuarios u where u.id = auth.uid())))
  with check ((select exists (select 1 from usuarios u where u.id = auth.uid())));
create policy panel_todo on bot for all to authenticated
  using      ((select exists (select 1 from usuarios u where u.id = auth.uid())))
  with check ((select exists (select 1 from usuarios u where u.id = auth.uid())));

-- Devuelve cuántos mensajes lleva ese chat (con este incluido) y si ya está
-- vinculado a un contacto. Con eso el webhook decide qué contestar: al
-- primero, el saludo; al segundo, el acuse; después, silencio. A un
-- contacto ya vinculado no se le contesta nada automático.
-- n = 0 significa que el aviso era un reintento ya guardado.
create or replace function recibir_telegram(
  p_secreto text, p_update_id bigint, p_chat_id bigint,
  p_nombre text, p_usuario text, p_texto text)
returns table (n int, vinculado boolean)
language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  if p_secreto is null or not exists
       (select 1 from bot b where b.id = 1 and b.secreto = p_secreto) then
    raise exception 'secreto inválido' using errcode = '28000';
  end if;

  insert into mensajes_telegram (update_id, chat_id, nombre, usuario, texto)
  values (p_update_id, p_chat_id, left(p_nombre, 200), left(p_usuario, 100),
          left(p_texto, 2000))
  on conflict (update_id) do nothing;

  if not found then
    return query select 0, false;
    return;
  end if;

  return query
    select (select count(*)::int from mensajes_telegram m where m.chat_id = p_chat_id),
           exists (select 1 from contactos c where c.telegram_id = p_chat_id);
end $$;

-- Supabase le da EXECUTE a anon y authenticated por defecto a cada función
-- nueva: se le saca a authenticated, que no la necesita. El linter va a
-- seguir marcando la de anon, y está bien: es el único que la usa, y sin el
-- secreto no hace nada.
revoke all on function recibir_telegram(text, bigint, bigint, text, text, text) from public;
revoke execute on function recibir_telegram(text, bigint, bigint, text, text, text) from authenticated;
grant execute on function recibir_telegram(text, bigint, bigint, text, text, text) to anon;
comment on function recibir_telegram is
  'Única puerta del webhook de Telegram. Exige el secreto de la tabla bot.';
