-- IDs correlativos (ajustar el START al importar datos existentes)
create sequence public.seq_reservas start 1;
create sequence public.seq_pagos start 1;
create sequence public.seq_clientes start 1;
create sequence public.seq_recordatorios start 1;
create sequence public.seq_usuarios start 1;
create sequence public.seq_canchas start 1;
create sequence public.seq_facturas start 1;

create table public.sesiones (
  token uuid primary key default gen_random_uuid(),
  usuario_id text not null references public.usuarios(usuario_id) on delete cascade,
  expira timestamptz not null, creada timestamptz not null default now()
);
create table public.otp_codes (
  email text primary key, codigo_hash text, intentos int not null default 0,
  expira timestamptz not null, ultimo_pedido timestamptz not null default now()
);
create table public.pagos_pendientes (
  token uuid primary key, payload jsonb not null, expira timestamptz not null,
  procesando boolean not null default false, resultado jsonb, creado timestamptz not null default now()
);
alter table public.sesiones enable row level security;
alter table public.otp_codes enable row level security;
alter table public.pagos_pendientes enable row level security;

create or replace function public.crear_reserva(p jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_cancha public.canchas%rowtype; v_horario public.horarios%rowtype;
  v_cliente_id text; v_email text := lower(trim(p->>'email'));
  v_fecha date := (p->>'fecha')::date; v_precio numeric;
  v_monto numeric := coalesce(nullif(p->>'monto','')::numeric, 0);
  v_saldo numeric; v_estado text; v_reserva_id text;
  v_registrado text := coalesce(nullif(p->>'registrado_por',''), 'CLIENTE');
  v_medio text := coalesce(p->>'medio_pago', ''); v_horas numeric; v_prog timestamptz;
begin
  select * into v_cancha from public.canchas where cancha_id = p->>'cancha_id';
  if not found or upper(v_cancha.activa) <> 'SI' then raise exception 'La cancha seleccionada no esta disponible.'; end if;
  select * into v_horario from public.horarios where horario_id = p->>'horario_id';
  if not found or upper(v_horario.activo) <> 'SI' then raise exception 'El horario seleccionado no esta disponible.'; end if;
  if exists (select 1 from public.reservas where fecha = v_fecha and horario_id = v_horario.horario_id
             and cancha_id = v_cancha.cancha_id and upper(estado) <> 'CANCELADA') then
    raise exception 'Ese turno acaba de ser ocupado. Elegi otro horario.';
  end if;
  select cliente_id into v_cliente_id from public.clientes where lower(email) = v_email limit 1;
  if found then
    update public.clientes set nombre = p->>'nombre', apellido = p->>'apellido', whatsapp = p->>'whatsapp' where cliente_id = v_cliente_id;
  else
    v_cliente_id := 'CLI' || lpad(nextval('public.seq_clientes')::text, 3, '0');
    insert into public.clientes (cliente_id, nombre, apellido, whatsapp, email, fecha_alta, activo, observaciones)
    values (v_cliente_id, p->>'nombre', p->>'apellido', p->>'whatsapp', v_email, now(), 'SI', '');
  end if;
  v_precio := coalesce(nullif(p->>'precio','')::numeric, v_cancha.precio);
  v_saldo := greatest(0, v_precio - v_monto);
  v_estado := case when v_saldo <= 0.01 then 'CONFIRMADA' else 'PARCIAL' end;
  v_reserva_id := 'RES' || lpad(nextval('public.seq_reservas')::text, 3, '0');
  begin
    insert into public.reservas (reserva_id, fecha, horario_id, cancha_id, cliente_id, estado, precio, sena, saldo,
                                 medio_pago, fecha_creacion, creado_por, observaciones)
    values (v_reserva_id, v_fecha, v_horario.horario_id, v_cancha.cancha_id, v_cliente_id, v_estado, v_precio,
            v_monto, v_saldo, v_medio, now(), v_registrado, coalesce(p->>'observaciones', ''));
  exception when unique_violation then
    raise exception 'Ese turno acaba de ser ocupado. Elegi otro horario.';
  end;
  if v_monto > 0 then
    insert into public.pagos (pago_id, reserva_id, fecha, tipo, monto, medio_pago, registrado_por, observaciones)
    values ('PAG' || lpad(nextval('public.seq_pagos')::text, 3, '0'), v_reserva_id, now(),
            coalesce(nullif(p->>'tipo_pago',''), 'SEÑA'), v_monto, v_medio, v_registrado,
            case when (p->>'es_online')::boolean then coalesce(nullif(p->>'nota_pago',''), 'Pago online') else '' end);
  end if;
  select coalesce(nullif(valor,'')::numeric, 24) into v_horas from public.config where parametro = 'Recordatorio_Email_Horas';
  v_horas := coalesce(nullif(v_horas, 0), 24);
  v_prog := ((v_fecha + v_horario.hora_inicio) at time zone 'America/Argentina/Buenos_Aires') - make_interval(hours => v_horas::int);
  if v_prog > now() then
    insert into public.recordatorios (recordatorio_id, reserva_id, tipo, fecha_programada, email, estado)
    values ('REC' || lpad(nextval('public.seq_recordatorios')::text, 3, '0'), v_reserva_id, '24H', v_prog, p->>'email', 'PENDIENTE');
  end if;
  return jsonb_build_object('reservaId', v_reserva_id, 'fecha', v_fecha,
    'horaInicio', to_char(v_horario.hora_inicio, 'HH24:MI'), 'horaFin', to_char(v_horario.hora_fin, 'HH24:MI'),
    'cancha', v_cancha.nombre, 'precio', v_precio, 'estado', v_estado, 'pagado', v_monto, 'saldo', v_saldo);
end; $$;

create or replace function public.registrar_pago(p jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_res public.reservas%rowtype; v_monto numeric := (p->>'monto')::numeric;
  v_pago_id text; v_pagado numeric; v_saldo numeric; v_estado text;
begin
  select * into v_res from public.reservas where reserva_id = p->>'reserva_id' for update;
  if not found then raise exception 'Reserva no encontrada.'; end if;
  if upper(v_res.estado) = 'CANCELADA' then raise exception 'No se pueden registrar pagos sobre una reserva cancelada.'; end if;
  if v_monto > coalesce(v_res.saldo, 0) + 0.01 then
    raise exception 'El monto ingresado (%) supera el saldo pendiente (%).', trim_scale(v_monto), trim_scale(coalesce(v_res.saldo,0));
  end if;
  v_pago_id := 'PAG' || lpad(nextval('public.seq_pagos')::text, 3, '0');
  insert into public.pagos (pago_id, reserva_id, fecha, tipo, monto, medio_pago, registrado_por, observaciones)
  values (v_pago_id, v_res.reserva_id, now(), p->>'tipo', v_monto, coalesce(p->>'medio_pago',''), p->>'registrado_por', coalesce(p->>'observaciones',''));
  v_pagado := coalesce(v_res.sena, 0) + v_monto;
  v_saldo := greatest(0, coalesce(v_res.precio, 0) - v_pagado);
  v_estado := case when v_saldo <= 0.01 then 'CONFIRMADA' else 'PARCIAL' end;
  update public.reservas set sena = v_pagado, saldo = v_saldo, estado = v_estado,
         medio_pago = coalesce(nullif(p->>'medio_pago',''), v_res.medio_pago, '')
   where reserva_id = v_res.reserva_id;
  return jsonb_build_object('pagoId', v_pago_id, 'saldoRestante', v_saldo, 'estado', v_estado);
end; $$;

revoke execute on function public.crear_reserva(jsonb) from public, anon, authenticated;
revoke execute on function public.registrar_pago(jsonb) from public, anon, authenticated;
