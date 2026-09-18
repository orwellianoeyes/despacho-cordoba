-- El índice miraba solo título, tipo y número. Medido el 18/09/2026:
--
--   "hídrica" en un TÍTULO ................  3 veces
--   "hídrica" en el campo `importa` ....... 21 veces
--
-- O sea que el análisis que la IA ya escribió —y que está pago— quedaba
-- afuera del buscador. Peor: buscar "emergencia hidrica" daba CERO, porque
-- las dos palabras nunca aparecen juntas en un título aunque sí en el
-- análisis. Y "emergencia hídrica" es uno de los temas vigilados de Leo.
--
-- Efecto medido al sumar `importa` y las cuatro miradas al vector:
--
--   emergencia hidrica ....  0 →  16
--   obra vial .............  2 →  35
--   tribunal de cuentas ...  5 →  14
--   paritaria docente .....  0 →   3
--
-- El título sigue siendo lo que se muestra; esto solo cambia por dónde se
-- encuentra. Se mantienen las dos configuraciones (con y sin tildes) por
-- lo de licitación/licitacion, explicado en la migración 004.

alter table normas drop column busqueda;
alter table normas add column busqueda tsvector
  generated always as (
    to_tsvector('spanish',
      coalesce(titulo,'') || ' ' || coalesce(tipo,'') || ' ' || coalesce(numero,'')
      || ' ' || coalesce(importa,'')
      || ' ' || coalesce(ampliada->>'juridica','')
      || ' ' || coalesce(ampliada->>'politica','')
      || ' ' || coalesce(ampliada->>'oficialista','')
      || ' ' || coalesce(ampliada->>'opositora',''))
    ||
    to_tsvector('public.espanol_sin_tildes',
      coalesce(titulo,'') || ' ' || coalesce(tipo,'') || ' ' || coalesce(numero,'')
      || ' ' || coalesce(importa,'')
      || ' ' || coalesce(ampliada->>'juridica','')
      || ' ' || coalesce(ampliada->>'politica','')
      || ' ' || coalesce(ampliada->>'oficialista','')
      || ' ' || coalesce(ampliada->>'opositora',''))
  ) stored;
create index normas_busqueda_idx on normas using gin (busqueda);
