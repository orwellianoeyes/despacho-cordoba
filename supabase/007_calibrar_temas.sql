-- Cuántas normas pegaría un tema, para calibrarlo ANTES de guardarlo.
--
-- Nace de una prueba: "licitacion" como tema matchea 14 normas por
-- edición, o sea casi toda la Sección 4. Quien carga los temas tiene que
-- ver eso antes, no cuando el cliente recibe cuarenta normas de golpe.
--
-- El promedio por edición es el número que importa: un tema que pega 3
-- veces por día es útil, uno que pega 40 es ruido.

create or replace function calibrar_tema(p_tema text, p_secciones text[])
returns table (total bigint, ediciones bigint, promedio_por_edicion numeric)
language sql stable security invoker as $$
  with pegadas as (
    select fecha from normas
    where seccion = any(p_secciones)
      and busqueda @@ plainto_tsquery('spanish', p_tema)
  )
  select count(*), count(distinct fecha),
         round(count(*)::numeric / greatest((select count(distinct fecha) from despachos), 1), 1)
  from pegadas;
$$;

comment on function calibrar_tema is
  'Cuánto pegaría un tema. Sirve para ver que "licitacion" es demasiado amplio antes de guardarlo, no después.';
