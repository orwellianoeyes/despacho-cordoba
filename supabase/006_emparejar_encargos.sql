-- Qué normas de una edición le tocan a cada encargo.
--
-- La lógica vive acá y no en el panel porque usa el índice de texto
-- completo. Replicarlo en el navegador sería bajarse la edición entera
-- para filtrar a mano.
--
-- Un encargo matchea si la norma es de una de sus secciones Y alguno de
-- sus temas aparece. Los temas van en OR: quien pide "APROSS" y "obra
-- vial" quiere las dos cosas, no las que tengan las dos.

create or replace function normas_del_encargo(p_encargo bigint, p_fecha date)
returns table (
  id bigint, fecha date, tipo text, numero text, titulo text,
  seccion text, pagina int, url_oficial text, destacada boolean,
  importa text, ampliada jsonb, extenso text, temas_que_pegaron text[]
)
language sql stable security invoker as $$
  select n.id, n.fecha, n.tipo, n.numero, n.titulo, n.seccion, n.pagina,
         n.url_oficial, n.destacada, n.importa, n.ampliada, n.extenso,
         array(select t from unnest(e.temas) t
                where n.busqueda @@ plainto_tsquery('spanish', t))
  from normas n
  cross join encargos e
  where e.id = p_encargo
    and n.fecha = p_fecha
    and n.seccion = any(e.secciones)
    and exists (select 1 from unnest(e.temas) t
                 where n.busqueda @@ plainto_tsquery('spanish', t))
  order by n.destacada desc, n.pagina, n.id;
$$;

comment on function normas_del_encargo is
  'Normas de una edición que le tocan a un encargo. Devuelve también qué temas pegaron, para poder mostrar por qué entró cada norma.';

-- Panorama del día: qué hay para quién. Es lo que el panel muestra a la
-- mañana para decidir a quién se le manda algo.
create or replace function pendientes_del_dia(p_fecha date)
returns table (
  encargo_id bigint, etiqueta text, temas text[],
  contacto_id bigint, contacto text, telegram_id bigint,
  cuantas bigint, ya_entregada boolean
)
language sql stable security invoker as $$
  select e.id, e.etiqueta, e.temas, c.id, c.nombre, c.telegram_id,
         (select count(*) from normas_del_encargo(e.id, p_fecha)),
         exists (select 1 from entregas g
                  where g.encargo_id = e.id and g.fecha = p_fecha
                    and g.estado = 'enviada')
  from encargos e
  join contactos c on c.id = e.contacto_id
  where e.activo and c.activo
  order by c.nombre, e.etiqueta;
$$;

comment on function pendientes_del_dia is
  'Qué hay para quién en una edición. `ya_entregada` evita mandar dos veces lo mismo.';
