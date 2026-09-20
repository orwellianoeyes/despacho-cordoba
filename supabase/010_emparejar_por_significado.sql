-- El emparejamiento de encargos deja de ser por palabra.
--
-- Por qué. `normas_del_encargo()` matcheaba con
-- `busqueda @@ plainto_tsquery('spanish', tema)`. Medido el 19/09/2026
-- sobre las 1.173 normas archivadas de las secciones 1 y 4:
--
--     tema escrito     queda como      pega
--     obra             'obra'           111
--     obras            'obras'           86
--     designaciones    'design'          87
--     designacion      'designacion'     67
--     licitaciones     'licit'          577
--     licitacion       'licitacion'     574
--
-- El stemmer español reduce unos plurales y otros no, sin regla que se
-- pueda aprender. Peor: las listas no se contienen. 69 normas pegan con
-- "obra" y NO con "obras"; la unión son 155. El encargo real decía
-- "obras", así que el cliente veía 86 de 155 — el 45% invisible por
-- haber escrito el plural.
--
-- Y aun con el plural correcto queda afuera todo lo que no comparte
-- palabra: "Pavimento Modular Completo Zona 1", "Mantenimiento y
-- Reparación de Puentes en Red Vial Pavimentada", "Construcción Nuevo
-- Edificio Hospital de Oliva" — esta última para alguien que pidió
-- salud Y obras.
--
-- Cómo queda. El juicio lo hace Jev (TypeSafe) del lado de la
-- aplicación: Supabase no permite instalar extensiones propias, así que
-- no hay WHERE semántico dentro del motor. El panel evalúa la edición
-- entera contra los temas del encargo y deja acá el resultado.

alter table encargos add column umbral real not null default 0.7;
comment on column encargos.umbral is
  'Desde qué probabilidad una norma entra en el encargo. Es la perilla '
  'ancho/angosto: un candidato en campaña quiere red ancha (0,5), un '
  'asesor quiere tres cosas y nada más (0,85).';

-- Se guardan TODAS las normas evaluadas con su probabilidad, no solo las
-- que superan el umbral. Dos razones: mover el umbral pasa a ser un
-- filtro de lectura que no vuelve a gastar inferencia, y la presencia de
-- filas distingue "ya se evaluó y no pegó nada" de "todavía no se evaluó".
create table coincidencias (
  encargo_id   bigint not null references encargos(id) on delete cascade,
  norma_id     bigint not null references normas(id)   on delete cascade,
  fecha        date   not null,
  prob         real   not null,          -- la más alta de todos los temas
  probs        jsonb  not null,          -- {"salud": 0.94, "obras": 0.11, ...}
  calculada_en timestamptz not null default now(),
  primary key (encargo_id, norma_id)
);
create index coincidencias_encargo_fecha_idx on coincidencias (encargo_id, fecha);

comment on table coincidencias is
  'Qué tan fuerte pega cada norma con cada tema de un encargo, según Jev. '
  'Se calcula una vez por (encargo, edición) y se reusa: abrir el panel '
  'diez veces no cuesta diez veces.';

alter table coincidencias enable row level security;
create policy panel_todo on coincidencias for all to authenticated
  using      ((select exists (select 1 from usuarios u where u.id = auth.uid())))
  with check ((select exists (select 1 from usuarios u where u.id = auth.uid())));

-- ---------- Lo que el panel lee ----------

-- Las candidatas: la edición entera en las secciones del encargo, sin
-- filtrar. Es lo que se le manda a Jev para que juzgue.
create or replace function candidatas_del_encargo(p_encargo bigint, p_fecha date)
returns table (id bigint, tipo text, numero text, titulo text, importa text)
language sql stable security invoker as $$
  select n.id, n.tipo, n.numero, n.titulo, n.importa
  from normas n
  cross join encargos e
  where e.id = p_encargo
    and n.fecha = p_fecha
    and n.seccion = any(e.secciones)
  order by n.pagina, n.id;
$$;
comment on function candidatas_del_encargo is
  'Todo lo que hay que juzgar para un encargo en una edición. Sin prefiltro '
  'por palabra: ese prefiltro era el problema.';

-- Mismo nombre y mismo lugar en el panel que antes; cambia de dónde sale
-- la verdad. Ahora ordena por probabilidad: en titulares entran ~15 y el
-- celular lee las tres primeras, así que el orden es parte del producto.
drop function if exists normas_del_encargo(bigint, date);
create or replace function normas_del_encargo(p_encargo bigint, p_fecha date)
returns table (
  id bigint, fecha date, tipo text, numero text, titulo text,
  seccion text, pagina int, url_oficial text, destacada boolean,
  importa text, ampliada jsonb, extenso text, temas_que_pegaron text[],
  prob real
)
language sql stable security invoker as $$
  select n.id, n.fecha, n.tipo, n.numero, n.titulo, n.seccion, n.pagina,
         n.url_oficial, n.destacada, n.importa, n.ampliada, n.extenso,
         array(select k from jsonb_each_text(c.probs) as p(k, v)
                where v::real >= e.umbral
                order by v::real desc),
         c.prob
  from coincidencias c
  join normas n   on n.id = c.norma_id
  join encargos e on e.id = c.encargo_id
  where c.encargo_id = p_encargo
    and c.fecha = p_fecha
    and c.prob >= e.umbral
  order by c.prob desc, n.pagina, n.id;
$$;
comment on function normas_del_encargo is
  'Normas de una edición que le tocan a un encargo, de más a menos '
  'relevante. Lee de `coincidencias`: si está vacío para ese día, todavía '
  'no se emparejó — el panel lo dispara solo.';

-- El panorama de la mañana. `emparejado` distingue "no hay nada para esta
-- persona" de "todavía no se miró", que antes era la misma cosa.
drop function if exists pendientes_del_dia(date);
create or replace function pendientes_del_dia(p_fecha date)
returns table (
  encargo_id bigint, etiqueta text, temas text[],
  contacto_id bigint, contacto text, telegram_id bigint,
  cuantas bigint, ya_entregada boolean, emparejado boolean, evaluadas bigint
)
language sql stable security invoker as $$
  select e.id, e.etiqueta, e.temas, c.id, c.nombre, c.telegram_id,
         (select count(*) from coincidencias k
           where k.encargo_id = e.id and k.fecha = p_fecha and k.prob >= e.umbral),
         exists (select 1 from entregas g
                  where g.encargo_id = e.id and g.fecha = p_fecha
                    and g.estado = 'enviada'),
         exists (select 1 from coincidencias k
                  where k.encargo_id = e.id and k.fecha = p_fecha),
         (select count(*) from coincidencias k
           where k.encargo_id = e.id and k.fecha = p_fecha)
  from encargos e
  join contactos c on c.id = e.contacto_id
  where e.activo and c.activo
  order by c.nombre, e.etiqueta;
$$;
comment on function pendientes_del_dia is
  'Qué hay para quién en una edición. `ya_entregada` evita mandar dos veces '
  'lo mismo; `emparejado` distingue "nada para esta persona" de "sin mirar".';

-- ---------- El calibrador ----------

-- `calibrar_tema()` usaba la MISMA consulta por palabra que el
-- emparejador, así que confirmaba el tema con el mismo error que después
-- perdía las normas. Se reemplaza por una muestra real de títulos que el
-- panel juzga con Jev y cuenta.
create or replace function candidatas_recientes(p_secciones text[], p_ediciones int)
returns table (id bigint, fecha date, tipo text, numero text, titulo text, importa text)
language sql stable security invoker as $$
  select n.id, n.fecha, n.tipo, n.numero, n.titulo, n.importa
  from normas n
  where n.seccion = any(p_secciones)
    and n.fecha in (select fecha from despachos
                    order by fecha desc limit greatest(p_ediciones, 1))
  order by n.fecha desc, n.pagina, n.id;
$$;
comment on function candidatas_recientes is
  'Muestra de las últimas ediciones para calibrar un tema antes de '
  'guardarlo. Acotada a propósito: calibrar no tiene que costar lo mismo '
  'que barrer el archivo entero.';

drop function if exists calibrar_tema(text, text[]);

-- El linter de Supabase marca las funciones sin search_path fijo. Son
-- todas `security invoker` —corren con el rol de quien llama, no con el
-- del dueño— así que el riesgo es bajo, pero cerrarlo es una línea.
-- `url_del_pdf` venía de la 009 y arrastraba el mismo aviso.
alter function url_del_pdf(date, text)              set search_path = public, pg_temp;
alter function candidatas_del_encargo(bigint, date) set search_path = public, pg_temp;
alter function normas_del_encargo(bigint, date)     set search_path = public, pg_temp;
alter function pendientes_del_dia(date)             set search_path = public, pg_temp;
alter function candidatas_recientes(text[], int)    set search_path = public, pg_temp;
