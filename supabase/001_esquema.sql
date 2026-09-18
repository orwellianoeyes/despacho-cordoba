-- ============================================================
-- DESPACHO DIARIO — esquema inicial
-- ============================================================
-- Modelo "concierge": un solo panel, el de Leo. Los contactos NO tienen
-- cuenta ni acceso; son destinatarios de Telegram. Nada se envía solo:
-- el sistema prepara y Leo despacha.
--
-- RLS activado en todas las tablas. El motor que corre en la Mac usa la
-- service_role (saltea RLS); el panel entra como usuario autenticado.
-- ============================================================

-- ---------- 1. El boletín procesado ----------

create table despachos (
  fecha             date primary key,
  numero_boletin    text not null default 's/d',
  secciones         text[] not null default '{}',
  motor             text not null,
  sintesis_juridica jsonb not null default '[]',
  sintesis_politica jsonb not null default '[]',
  telegram          text,
  hora_procesado    text,
  creado_en         timestamptz not null default now()
);
comment on table despachos is
  'Un despacho por edición. La fecha es la clave: regenerar un día lo pisa.';
comment on column despachos.motor is
  'Qué IA lo escribió (claude|gemini). El suplente sale más flojo: hay que '
  'poder saberlo antes de reenviarle el resumen a alguien.';

-- ---------- 2. Las normas ----------
-- UNA sola tabla para todo el boletín, no dos. Las "destacadas" son las
-- que el despacho del día analizó; el resto entra solo con metadatos y su
-- análisis queda NULL hasta que alguien lo pida desde el buscador. Así el
-- buscador encuentra todo y el análisis se llena a demanda, una sola vez.

create table normas (
  id            bigint generated always as identity primary key,
  fecha         date not null references despachos(fecha) on delete cascade,
  tipo          text not null default '',
  clase         text,
  numero        text not null default '',
  titulo        text not null default '',
  seccion       text not null default '1',
  pagina        int  not null default 1,
  url_oficial   text,

  destacada     boolean not null default false,
  importa       text,
  ampliada      jsonb,          -- {juridica, politica, oficialista, opositora}
  texto_oficial text,
  analizada_en  timestamptz,
  analizada_por text,           -- motor que escribió `ampliada`

  -- El número NO identifica una norma: una edición trae doce edictos
  -- distintos todos con numero 's/n', y notificaciones con numero
  -- 'Juzgado Electoral'. Deduplicar sin el título borraría normas reales.
  unique (fecha, tipo, numero, titulo)
);
comment on table normas is
  'Todas las normas de cada edición. destacada=true son las que el despacho '
  'analizó; las demás se pueden analizar después a pedido, desde el buscador.';

-- Búsqueda por texto en español, en la base y no en el navegador.
-- Hoy el buscador se baja un JSON de 294 KB y filtra a mano; no escala.
alter table normas add column busqueda tsvector
  generated always as (
    to_tsvector('spanish',
      coalesce(titulo,'') || ' ' || coalesce(tipo,'') || ' ' || coalesce(numero,''))
  ) stored;
create index normas_busqueda_idx on normas using gin (busqueda);
create index normas_fecha_idx     on normas (fecha desc);
create index normas_destacada_idx on normas (fecha desc) where destacada;

-- ---------- 3. El texto crudo ----------
-- Lo que permite resumir después cualquier norma del índice sin volver a
-- pedirle el PDF al Boletín, que desde la nube responde 403. Se guarda
-- ANTES de llamar a la IA, así que nunca se degrada por el motor que toque.

create table paginas (
  fecha    date not null,
  seccion  text not null,
  pagina   int  not null,
  texto    text not null default '',
  url      text,
  primary key (fecha, seccion, pagina)
);
comment on table paginas is
  'Texto del boletín, página por página. Una norma se ubica por '
  '(fecha, seccion, pagina), que es justo lo que guarda `normas`.';

-- ---------- 4. La libreta ----------

create table contactos (
  id          bigint generated always as identity primary key,
  nombre      text not null,
  telegram_id bigint unique,   -- null hasta que le escriba al bot
  notas       text,
  activo      boolean not null default true,
  creado_en   timestamptz not null default now()
);
comment on table contactos is
  'Destinatarios. No tienen cuenta ni acceso al panel: solo reciben. '
  'telegram_id se completa cuando la persona le escribe al bot.';

create table encargos (
  id          bigint generated always as identity primary key,
  contacto_id bigint not null references contactos(id) on delete cascade,
  etiqueta    text not null,          -- "Salud y APROSS", "Obra vial"
  temas       text[] not null default '{}',
  secciones   text[] not null default '{1,4}',
  activo      boolean not null default true,
  creado_en   timestamptz not null default now()
);
comment on table encargos is
  'Qué vigila cada contacto. Queda vivo día a día, pero NO dispara envíos: '
  'solo arma lo que Leo va a revisar.';

-- ---------- 5. Lo que se manda ----------

create table entregas (
  id          bigint generated always as identity primary key,
  contacto_id bigint not null references contactos(id) on delete cascade,
  encargo_id  bigint references encargos(id) on delete set null,
  fecha       date not null,            -- edición sobre la que se arma
  norma_ids   bigint[] not null default '{}',
  canal       text not null default 'telegram',
  estado      text not null default 'preparada',  -- preparada|enviada|descartada
  texto       text,                     -- lo que efectivamente se mandó
  preparada_en timestamptz not null default now(),
  enviada_en  timestamptz
);
comment on table entregas is
  'Bitácora. Una fila por cada cosa preparada para alguien. Nada pasa a '
  'enviada sin que Leo lo despache. `texto` guarda lo que realmente salió.';
create index entregas_pendientes_idx on entregas (fecha desc) where estado = 'preparada';

-- ---------- 6. El buzón de corridas ----------
-- El panel vive en la nube y la Mac baja los PDF (el Boletín bloquea con
-- 403 a las IP de datacenter). La nube no puede darle órdenes a la Mac,
-- así que se da vuelta: el panel deja el pedido acá y la Mac lo levanta.

create table corridas (
  id           bigint generated always as identity primary key,
  fecha        date not null,
  secciones    text[] not null default '{1,4}',
  motor        text not null default 'claude',
  sin_ia       boolean not null default false,
  estado       text not null default 'pendiente', -- pendiente|tomada|lista|fallida
  detalle      text,
  pedida_en    timestamptz not null default now(),
  tomada_en    timestamptz,
  terminada_en timestamptz
);
comment on table corridas is
  'Buzón: el panel pide, la Mac levanta. Nunca al revés — la Mac no queda '
  'expuesta a internet.';
create index corridas_pendientes_idx on corridas (pedida_en) where estado = 'pendiente';

-- ---------- 7. Acceso al panel ----------

create table usuarios (
  id        uuid primary key references auth.users(id) on delete cascade,
  email     text not null,
  creado_en timestamptz not null default now()
);
comment on table usuarios is
  'Acceso al panel por invitación; no hay registro público. Hoy: solo Leo.';

-- ---------- 8. RLS ----------
-- Todo cerrado. El motor entra con service_role (saltea RLS). El panel
-- entra autenticado y solo si está en `usuarios`.

alter table despachos enable row level security;
alter table normas    enable row level security;
alter table paginas   enable row level security;
alter table contactos enable row level security;
alter table encargos  enable row level security;
alter table entregas  enable row level security;
alter table corridas  enable row level security;
alter table usuarios  enable row level security;

-- El chequeo va inline y NO en una función SECURITY DEFINER: una función
-- así queda expuesta como /rest/v1/rpc/... y el linter de Supabase la marca,
-- con razón. Revocarle el EXECUTE tampoco sirve, porque las políticas RLS se
-- evalúan con el rol que llama y dejarían de funcionar.
--
-- `usuarios` tiene su propia política (cada uno ve solo su fila), así que el
-- EXISTS da true únicamente para quien está invitado al panel. El (select ...)
-- exterior hace que Postgres lo evalúe una vez por consulta, no por fila.

do $$
declare t text;
begin
  foreach t in array array['despachos','normas','paginas','contactos',
                           'encargos','entregas','corridas']
  loop
    execute format(
      'create policy panel_todo on %I for all to authenticated
         using      ((select exists (select 1 from usuarios u where u.id = auth.uid())))
         with check ((select exists (select 1 from usuarios u where u.id = auth.uid())))', t);
  end loop;
end $$;

create policy usuarios_se_ven on usuarios
  for select to authenticated using (id = auth.uid());
