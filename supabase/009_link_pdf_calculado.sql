-- 1167 de 1222 normas habían quedado sin link al PDF. La causa: al fusionar
-- una destacada con su fila del índice se copiaban el análisis y la página
-- pero no el link, así que quedaba el vacío que traía la fila del índice.
--
-- El link no hacía falta arrastrarlo: se calcula. El patrón está verificado
-- contra ediciones reales desde julio:
--
--   .../wp-content/4p96humuzp/AAAA/MM/{seccion}_Secc_DDMMAA.pdf
--
-- Con la fecha y la sección —que toda norma tiene— alcanza.

create or replace function url_del_pdf(p_fecha date, p_seccion text)
returns text language sql immutable as $$
  select 'https://boletinoficial.cba.gov.ar/wp-content/4p96humuzp/'
      || to_char(p_fecha, 'YYYY/MM/')
      || p_seccion || '_Secc_' || to_char(p_fecha, 'DDMMYY') || '.pdf';
$$;

comment on function url_del_pdf is
  'El PDF de una sección se deduce de la fecha: no hay que arrastrar el link, se calcula.';

update normas set url_oficial = url_del_pdf(fecha, seccion)
 where coalesce(url_oficial,'') = '' or url_oficial <> url_del_pdf(fecha, seccion);
update movimientos set url_oficial = url_del_pdf(fecha, '1')
 where coalesce(url_oficial,'') = '';
