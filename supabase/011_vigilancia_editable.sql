-- Los TEMAS VIGILADOS salen del código y pasan al panel.
--
-- Por qué. Eran una lista dentro de `instrucciones.md`: para agregar un
-- tema había que abrir el repo en la Mac. Ahora se editan desde la pestaña
-- Vigilancia, que es donde Leo está cuando se le ocurre el tema.
--
-- Lo que NO cambia, y es importante: siguen siendo SU criterio editorial.
-- No se alimentan de `encargos.temas`. Las razones están en el CLAUDE.md,
-- sección "Dos listas de temas que NO hay que mezclar"; en resumen, el
-- ahorro medido de acoplarlas es un centavo por edición y el costo es que
-- el archivo deje de ser comparable en el tiempo.
--
-- El motor los trae de acá y reemplaza los bloques marcados del
-- instructivo. **Si Supabase no contesta usa el archivo y lo avisa**: eso
-- deja a `boletin.py` funcionando solo, que es la propiedad que hace que
-- --rehacer y --sin-ia siempre anden.

create table vigilancia (
  id              int primary key default 1 check (id = 1),
  temas           text[] not null default '{}',
  min_destacadas  int not null default 3  check (min_destacadas between 1 and 40),
  max_destacadas  int not null default 10 check (max_destacadas between 1 and 40),
  actualizado_en  timestamptz not null default now(),
  check (max_destacadas >= min_destacadas)
);

comment on table vigilancia is
  'Los TEMAS VIGILADOS de Leo y cuántas normas destacar por día. Una sola fila.';

alter table vigilancia enable row level security;
create policy panel_todo on vigilancia for all to authenticated
  using      ((select exists (select 1 from usuarios u where u.id = auth.uid())))
  with check ((select exists (select 1 from usuarios u where u.id = auth.uid())));

insert into vigilancia (id, temas, min_destacadas, max_destacadas) values (1, array[
  'APROSS (financiamiento, aportes, emergencia sanitaria, convenios)',
  'Obra vial provincial (licitaciones, adjudicaciones, convenios de mantenimiento)',
  'Emergencia hídrica y contrataciones de excepción',
  'Educación / paritaria docente / UEPC',
  'Tribunal de Cuentas: competencias y designaciones',
  'Gobierno digital, firma digital, modernización del Estado',
  'Endeudamientos y pagos del estado a acreedores nacionales o internacionales',
  'Ejecuciones presupuestarias'
], 3, 10);

-- Cuántas normas se resumieron A MANO por edición. El motor deja
-- destacada=true en lo que analiza él; lo que se resume desde el panel
-- queda en false. Medido el 22/09/2026: destacar una norma en el despacho
-- diario sale 0,36 centavos y resumirla a pedido 0,61, porque el pedido a
-- mano tiene que remandar el texto de la página. Destacar las 14 que
-- faltaban costaba 5,0 centavos, así que el punto de equilibrio son
-- 5,0/0,61 = 8,2 normas por edición.
create or replace function resumidas_a_mano(p_ediciones int default 10)
returns table (ediciones bigint, a_mano bigint, promedio numeric)
language sql stable security invoker
set search_path = public, pg_temp as $$
  with ultimas as (select fecha from despachos order by fecha desc limit greatest(p_ediciones, 1))
  select (select count(*) from ultimas),
         count(*),
         round(count(*)::numeric / greatest((select count(*) from ultimas), 1), 1)
  from normas n
  where n.fecha in (select fecha from ultimas)
    and n.ampliada is not null and not n.destacada;
$$;
comment on function resumidas_a_mano is
  'Cuántas normas se resumieron a pedido por edición. Más de 8 de promedio significa que conviene subir el rango de destacadas.';
