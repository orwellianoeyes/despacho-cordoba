-- Nadie escribe con tildes en un buscador, y ninguna configuración sola
-- resuelve el problema. Está medido:
--
--                 'spanish'      'espanol_sin_tildes'
--   licitación     licit          licitacion
--   licitacion     licitacion     licitacion
--   licitaciones   licit          licit
--
-- El analizador de español corta el sufijo -ción solo cuando está la tilde;
-- sin tilde deja la palabra entera. Con solo 'spanish' se pierde quien
-- escribe sin tildes (o sea, todos). Con solo 'sin_tildes' se pierde el
-- plural, que es como buscó Leo la primera vez y por eso se detectó.
--
-- Se indexa con las dos y se unen los vectores: el índice queda con 'licit'
-- Y 'licitacion', así que cualquiera de las tres formas encuentra. Son 1008
-- filas: duplicar el índice no cuesta nada.
--
-- La consulta del panel sigue usando 'spanish'; no hace falta cambiarla.

create extension if not exists unaccent with schema extensions;

drop text search configuration if exists public.espanol_sin_tildes;
create text search configuration public.espanol_sin_tildes ( copy = spanish );
alter text search configuration public.espanol_sin_tildes
  alter mapping for hword, hword_part, word
  with unaccent, spanish_stem;

comment on text search configuration public.espanol_sin_tildes is
  'Español, pero ignorando tildes: quien busca no las escribe.';

-- La expresión de una columna generada no se puede editar: hay que rehacerla.
-- El índice se va con la columna, así que también se recrea.
alter table normas drop column busqueda;
alter table normas add column busqueda tsvector
  generated always as (
    to_tsvector('spanish',
      coalesce(titulo,'') || ' ' || coalesce(tipo,'') || ' ' || coalesce(numero,''))
    ||
    to_tsvector('public.espanol_sin_tildes',
      coalesce(titulo,'') || ' ' || coalesce(tipo,'') || ' ' || coalesce(numero,''))
  ) stored;
create index normas_busqueda_idx on normas using gin (busqueda);
