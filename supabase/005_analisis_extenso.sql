-- El análisis extenso va en su propia columna y NO pisa el resumen corto:
-- son dos productos distintos. El corto es para el despacho y para mirar de
-- reojo; el extenso es lo que se le manda a un cliente que pidió entender
-- una norma en particular.

alter table normas
  add column extenso      text,
  add column extenso_en   timestamptz,
  add column extenso_por  text;

comment on column normas.extenso is
  'Análisis en profundidad, a pedido. Markdown. Se paga una vez y queda.';
comment on column normas.extenso_por is
  'Modelo que lo escribió. Importa: el diario usa Haiku por volumen y esto usa Opus porque es lo que ve el cliente.';
