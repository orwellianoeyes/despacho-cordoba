-- Faltaba: sin esto, pedir desde el panel una fecha que ya tiene despacho
-- no hace nada (el motor es idempotente y sale sin trabajar). Es justo lo
-- que se necesita para regenerar un día que salió con el motor de respaldo.
alter table corridas add column rehacer boolean not null default false;
comment on column corridas.rehacer is
  'Regenerar aunque el despacho de esa fecha ya exista (pisa el anterior).';
