-- Faltaba en el esquema inicial. Los movimientos (designaciones, renuncias,
-- creación o supresión de organismos) no son normas: tienen instrumento y
-- organismo en vez de número y articulado, y la app les da sección propia.
-- Meterlos en `normas` habría ensuciado el buscador con filas a las que les
-- falta la mitad de las columnas.

create table movimientos (
  id          bigint generated always as identity primary key,
  fecha       date not null references despachos(fecha) on delete cascade,
  tipo        text not null default '',      -- Designación | Renuncia | Creación | Supresión
  clase       text,
  instrumento text not null default '',
  titulo      text not null default '',
  detalle     text,
  organismo   text,
  pagina      int not null default 1,
  url_oficial text,
  unique (fecha, tipo, instrumento, titulo)
);
comment on table movimientos is
  'Designaciones, renuncias y cambios de estructura del Estado. Separados de `normas` porque son otra cosa: instrumento y organismo, no número y articulado.';
create index movimientos_fecha_idx on movimientos (fecha desc);

alter table movimientos enable row level security;
create policy panel_todo on movimientos for all to authenticated
  using      ((select exists (select 1 from usuarios u where u.id = auth.uid())))
  with check ((select exists (select 1 from usuarios u where u.id = auth.uid())));
