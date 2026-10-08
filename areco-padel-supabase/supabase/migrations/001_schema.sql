-- Tablas equivalentes a las hojas del Google Sheets (encabezados en snake_case)
create table public.config (parametro text primary key, valor text);

create table public.canchas (
  cancha_id text primary key, nombre text not null, tipo text,
  precio numeric(12,2) not null default 0, activa text not null default 'SI'
);

create table public.horarios (
  horario_id text primary key, hora_inicio time not null, hora_fin time not null,
  activo text not null default 'SI'
);

create table public.clientes (
  cliente_id text primary key, nombre text, apellido text, whatsapp text, email text,
  fecha_alta timestamptz default now(), activo text not null default 'SI', observaciones text
);

create table public.usuarios (
  usuario_id text primary key, nombre text, email text unique, rol text,
  activo text not null default 'SI'
);

create table public.reservas (
  reserva_id text primary key, fecha date not null,
  horario_id text not null references public.horarios(horario_id),
  cancha_id text not null references public.canchas(cancha_id),
  cliente_id text not null references public.clientes(cliente_id),
  estado text not null default 'CONFIRMADA',
  precio numeric(12,2) default 0, sena numeric(12,2) default 0, saldo numeric(12,2) default 0,
  medio_pago text, fecha_creacion timestamptz default now(), creado_por text, observaciones text
);
-- Evita doble reserva de la misma cancha/fecha/horario (las canceladas no cuentan)
create unique index reservas_slot_unico on public.reservas (fecha, horario_id, cancha_id) where estado <> 'CANCELADA';
create index reservas_fecha_idx on public.reservas (fecha);
create index reservas_cliente_idx on public.reservas (cliente_id);

create table public.pagos (
  pago_id text primary key, reserva_id text not null references public.reservas(reserva_id),
  fecha timestamptz default now(), tipo text, monto numeric(12,2) not null default 0,
  medio_pago text, registrado_por text, observaciones text
);
create index pagos_reserva_idx on public.pagos (reserva_id);

create table public.facturas (
  factura_id text primary key, reserva_id text references public.reservas(reserva_id),
  pago_id text references public.pagos(pago_id), tipo_comprobante text, punto_venta text,
  numero text, cae text, cae_vencimiento date, fecha_emision timestamptz, monto numeric(12,2),
  cliente_nombre text, cliente_email text, estado text, pdf_url text, error text,
  intentos integer default 0, tipo_pago text
);

create table public.recordatorios (
  recordatorio_id text primary key, reserva_id text references public.reservas(reserva_id),
  tipo text, fecha_programada timestamptz, email text, estado text default 'PENDIENTE', fecha_envio timestamptz
);
create index recordatorios_pend_idx on public.recordatorios (estado, fecha_programada);

-- Seguridad: RLS en todas las tablas
alter table public.config enable row level security;
alter table public.canchas enable row level security;
alter table public.horarios enable row level security;
alter table public.clientes enable row level security;
alter table public.usuarios enable row level security;
alter table public.reservas enable row level security;
alter table public.pagos enable row level security;
alter table public.facturas enable row level security;
alter table public.recordatorios enable row level security;

create policy "lectura publica canchas" on public.canchas for select to anon, authenticated using (true);
create policy "lectura publica horarios" on public.horarios for select to anon, authenticated using (true);
create policy "lectura publica config" on public.config for select to anon, authenticated using (true);
