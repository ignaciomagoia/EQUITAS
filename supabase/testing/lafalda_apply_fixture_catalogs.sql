-- SOLO PARA EQUITAS-TP-TESTING.
-- Preparacion idempotente de los catalogos minimos para la prueba aislada.
-- No modifica ni elimina registros existentes; solo inserta datos sinteticos si faltan.
-- No ejecutar en Produccion ni incluir en las migraciones generales.

create table if not exists public.equitas_testing_fixture_control (
  id boolean primary key default true check (id),
  environment_label text not null check (environment_label = 'EQUITAS-TP-TESTING'),
  fixture_active boolean not null default false,
  previous_apply_enabled boolean,
  updated_at timestamp with time zone not null default now()
);

alter table public.equitas_testing_fixture_control
  add column if not exists fixture_active boolean not null default false;

alter table public.equitas_testing_fixture_control
  add column if not exists previous_apply_enabled boolean;

insert into public.equitas_testing_fixture_control (id, environment_label)
values (true, 'EQUITAS-TP-TESTING')
on conflict (id) do update
set environment_label = excluded.environment_label,
    updated_at = now();

do $$
declare
  v_next_id bigint;
  v_apply_enabled boolean;
begin
  if not exists (select 1 from public.tenant where id = 1) then
    raise exception 'Falta tenant 1. Primero complete el esquema y los datos sinteticos base de Testing.';
  end if;

  insert into public.lafalda_import_control (tenant, apply_enabled)
  values (1, false)
  on conflict (tenant) do nothing;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('lafalda-imports', 'lafalda-imports', false, 104857600, array['text/csv'])
  on conflict (id) do nothing;

  select apply_enabled
  into v_apply_enabled
  from public.lafalda_import_control
  where tenant = 1;

  if coalesce(v_apply_enabled, false) then
    raise exception 'apply_enabled ya esta activo; no se prepara el fixture sobre un apply habilitado.';
  end if;

  if not exists (
    select 1 from public.role where name = 'equitastp_fixture_importer'
  ) then
    select coalesce(max(id), 0) + 1 into v_next_id from public.role;
    insert into public.role (id, name, description)
    values (
      v_next_id,
      'equitastp_fixture_importer',
      'Rol sintetico exclusivo de la prueba aislada de importacion CSV.'
    );
  end if;

  if not exists (
    select 1 from public.debtor_type where key = 'equitastp_fixture_debtor_type'
  ) then
    select coalesce(max(id), 0) + 1 into v_next_id from public.debtor_type;
    insert into public.debtor_type (id, key, value, active)
    values (
      v_next_id,
      'equitastp_fixture_debtor_type',
      'Objeto sintetico de testing',
      true
    );
  end if;

  if not exists (select 1 from public.currency where code = 'ARS') then
    select coalesce(max(id), 0) + 1 into v_next_id from public.currency;
    insert into public.currency (id, code, name, active)
    values (v_next_id, 'ARS', 'Peso argentino', true);
  end if;

  if not exists (select 1 from public.debt_status where id = 2) then
    if exists (
      select 1 from public.debt_status where key = 'equitastp_fixture_overdue'
    ) then
      raise exception 'El estado sintetico existe con un ID distinto de 2; no se lo modifica automaticamente.';
    end if;

    insert into public.debt_status (id, key, value, description, active)
    values (
      2,
      'equitastp_fixture_overdue',
      'Vencida de testing',
      'Estado sintetico requerido porque el modelo actual identifica vencidas con ID 2.',
      true
    );
  end if;

  if not exists (
    select 1 from public.contact_type where key = 'equitastp_fixture_contact'
  ) then
    select coalesce(max(id), 0) + 1 into v_next_id from public.contact_type;
    insert into public.contact_type (id, key, value, priority, active)
    values (
      v_next_id,
      'equitastp_fixture_contact',
      'Contacto sintetico de testing',
      1,
      true
    );
  end if;
end;
$$;

notify pgrst, 'reload schema';
