-- SOLO PARA EQUITAS-TP-TESTING.
-- No ejecutar en produccion ni incluir en las migraciones generales.
-- Requiere las migraciones de importacion y autorizacion ya aplicadas.
-- Requiere ejecutar antes la preparacion de catalogos sinteticos de este directorio.
-- Requiere un generador para public.debt.id en Testing.

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

create or replace function public.testing_cleanup_lafalda_apply_fixture()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fixture_active boolean;
  v_previous_apply_enabled boolean;
  v_fixture_user_id constant bigint := 990000001;
  v_fixture_person_id constant bigint := 990000001;
  v_fixture_debtor_id constant bigint := 990000001;
begin
  select fixture_active, previous_apply_enabled
  into v_fixture_active, v_previous_apply_enabled
  from public.equitas_testing_fixture_control
  where id and environment_label = 'EQUITAS-TP-TESTING'
  for update;

  if not found then
    raise exception 'Fixture de testing no habilitado para este proyecto.';
  end if;

  if coalesce(v_fixture_active, false) is not true then
    return;
  end if;

  -- Solo se eliminan filas identificadas por los IDs sinteticos de este fixture.
  delete from public.data_import_job
  where requested_by = v_fixture_user_id;

  delete from public.debtor where id = v_fixture_debtor_id;
  delete from public.person where id = v_fixture_person_id;
  delete from public.tenant_user where "user" = v_fixture_user_id;
  delete from public.data_import_authorization
  where tenant = 1 and app_user = v_fixture_user_id;
  delete from public."user" where id = v_fixture_user_id;

  update public.lafalda_import_control
  set apply_enabled = coalesce(v_previous_apply_enabled, false),
      updated_at = now()
  where tenant = 1;

  update public.equitas_testing_fixture_control
  set fixture_active = false,
      previous_apply_enabled = null,
      updated_at = now()
  where id;
end;
$$;

-- PostgreSQL no permite cambiar el tipo de retorno con CREATE OR REPLACE.
-- Esta funcion solo existe en EQUITAS-TP-TESTING y no forma parte de Produccion.
drop function if exists public.testing_prepare_lafalda_apply_fixture();

create or replace function public.testing_prepare_lafalda_apply_fixture()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fixture_user_id constant bigint := 990000001;
  v_fixture_person_id constant bigint := 990000001;
  v_fixture_debtor_id constant bigint := 990000001;
  v_fixture_account constant bigint := 990000001;
  v_fixture_debt_one_id constant bigint := 990000011;
  v_fixture_debt_two_id constant bigint := 990000012;
  v_fixture_debt_absent_id constant bigint := 990000013;
  v_fixture_debt_one_external_id constant bigint := 990000001;
  v_fixture_debt_two_external_id constant bigint := 990000002;
  v_fixture_debt_absent_external_id constant bigint := 990000003;
  v_role_id bigint;
  v_debtor_type_id bigint;
  v_currency_id bigint;
  v_debt_status_id bigint;
  v_contact_type_id bigint;
  v_previous_apply_enabled boolean;
begin
  if exists (
    select 1
    from public.equitas_testing_fixture_control
    where id and environment_label = 'EQUITAS-TP-TESTING' and fixture_active
  ) then
    perform public.testing_cleanup_lafalda_apply_fixture();
  end if;

  select apply_enabled
  into v_previous_apply_enabled
  from public.lafalda_import_control
  where tenant = 1
  for update;

  if not found then
    raise exception 'Falta el control de importacion del tenant 1.';
  end if;

  if v_previous_apply_enabled then
    raise exception 'El apply ya estaba habilitado antes del fixture; no se modifica.';
  end if;

  if not exists (select 1 from public.tenant where id = 1) then
    raise exception 'Falta el tenant 1 requerido por la prueba aislada.';
  end if;

  select id into v_role_id
  from public.role
  where name = 'equitastp_fixture_importer';
  select id into v_debtor_type_id
  from public.debtor_type
  where key = 'equitastp_fixture_debtor_type';
  select id into v_currency_id
  from public.currency
  where code = 'ARS'
  limit 1;
  select id into v_debt_status_id from public.debt_status where id = 2;
  select id into v_contact_type_id
  from public.contact_type
  where key = 'equitastp_fixture_contact';

  if v_role_id is null
     or v_debtor_type_id is null
     or v_currency_id is null
     or v_debt_status_id is null
     or v_contact_type_id is null then
    raise exception
      'Faltan catalogos sinteticos de testing. Ejecute lafalda_apply_fixture_catalogs.sql antes del fixture.';
  end if;

  -- No se sobrescriben datos ajenos si los IDs o claves sinteticas ya pertenecen a otro registro.
  if exists (
    select 1 from public."user"
    where (id = v_fixture_user_id and email is distinct from 'equitastp-fixture-importer@example.test')
       or (email = 'equitastp-fixture-importer@example.test' and id <> v_fixture_user_id)
  ) then
    raise exception 'Colision con un usuario ajeno al fixture.';
  end if;

  if exists (
    select 1 from public.person
    where (id = v_fixture_person_id and external_id <> v_fixture_person_id)
       or (external_id = v_fixture_person_id and id <> v_fixture_person_id)
  ) then
    raise exception 'Colision con una persona ajena al fixture.';
  end if;

  if exists (
    select 1 from public.debtor
    where (id = v_fixture_debtor_id and (
      tenant <> 1 or type <> v_debtor_type_id or external_id <> v_fixture_account
    ))
       or (tenant = 1 and type = v_debtor_type_id and external_id = v_fixture_account
           and id <> v_fixture_debtor_id)
  ) then
    raise exception 'Colision con un objeto de deuda ajeno al fixture.';
  end if;

  if exists (
    select 1 from public.debt
    where (id = v_fixture_debt_one_id and (
      debtor <> v_fixture_debtor_id or external_id <> v_fixture_debt_one_external_id
    ))
       or (id = v_fixture_debt_two_id and (
         debtor <> v_fixture_debtor_id or external_id <> v_fixture_debt_two_external_id
       ))
       or (id = v_fixture_debt_absent_id and (
         debtor <> v_fixture_debtor_id or external_id <> v_fixture_debt_absent_external_id
       ))
  ) then
    raise exception 'Colision con una deuda ajena al fixture.';
  end if;

  if exists (
    select 1 from public.tenant_user
    where id = v_fixture_user_id
      and (tenant <> 1 or "user" <> v_fixture_user_id)
  )
  or exists (
    select 1 from public.debtor_person
    where id = v_fixture_debtor_id
      and (debtor <> v_fixture_debtor_id or person <> v_fixture_person_id)
  )
  or exists (
    select 1 from public.debtor_contact
    where id = v_fixture_person_id and person <> v_fixture_person_id
  )
  or exists (
    select 1 from public.debtor_profile
    where id = v_fixture_debtor_id and debtor <> v_fixture_debtor_id
  )
  or exists (
    select 1 from public.debtor_profile_detail
    where id = v_fixture_debtor_id
      and (debtor_profile <> v_fixture_debtor_id or person <> v_fixture_person_id)
  ) then
    raise exception 'Colision con relaciones o perfiles ajenos al fixture.';
  end if;

  -- Se marca primero para que una ejecucion interrumpida pueda limpiarse en el siguiente intento.
  update public.equitas_testing_fixture_control
  set fixture_active = true,
      previous_apply_enabled = v_previous_apply_enabled,
      updated_at = now()
  where id and environment_label = 'EQUITAS-TP-TESTING';

  insert into public."user" (id, full_name, email, status)
  values (
    v_fixture_user_id,
    'Usuario sintetico de testing',
    'equitastp-fixture-importer@example.test',
    'ACTIVE'
  );

  insert into public.tenant_user (id, tenant, "user", role, status)
  values (v_fixture_user_id, 1, v_fixture_user_id, v_role_id, true);

  insert into public.person (id, external_id, document_number, full_name)
  values (
    v_fixture_person_id,
    v_fixture_person_id,
    'TEST-990000001',
    'Persona sintetica de prueba'
  );

  insert into public.debtor (id, tenant, external_id, type, identifier, description, status)
  values (
    v_fixture_debtor_id,
    1,
    v_fixture_account,
    v_debtor_type_id,
    'TEST-990000001',
    'Objeto sintetico exclusivo del fixture',
    true
  );

  insert into public.debtor_person (id, debtor, person, priority, role, active)
  values (
    v_fixture_debtor_id,
    v_fixture_debtor_id,
    v_fixture_person_id,
    100,
    'Responsable de prueba',
    true
  );

  insert into public.debtor_contact (id, person, type, value, active)
  values (
    v_fixture_person_id,
    v_fixture_person_id,
    v_contact_type_id,
    'fixture-contact@example.test',
    true
  );

  insert into public.debt (
    id, external_id, debtor, type, description, original_amount, current_amount,
    currency, issue_date, due_date, last_collection_date, period, status
  )
  values
    (
      v_fixture_debt_one_id, v_fixture_debt_one_external_id, v_fixture_debtor_id,
      'inmueble', 'Deuda actualizable', 80, 100, v_currency_id,
      '2025-01-01', '2025-02-01', '2025-02-15', '2025-01', v_debt_status_id
    ),
    (
      v_fixture_debt_two_id, v_fixture_debt_two_external_id, v_fixture_debtor_id,
      'inmueble', 'Deuda parcial', 200, 250, v_currency_id,
      '2025-01-01', '2025-02-01', '2025-02-15', '2025-01', v_debt_status_id
    ),
    (
      v_fixture_debt_absent_id, v_fixture_debt_absent_external_id, v_fixture_debtor_id,
      'inmueble', 'Deuda ausente que se conserva', 400, 500, v_currency_id,
      '2025-01-01', '2025-02-01', '2025-02-15', '2025-01', v_debt_status_id
    );

  insert into public.debtor_profile (
    id, debtor, total_debt_amount, overdue_debt_amount, debt_count,
    overdue_debt_count, oldest_debt_days, average_debt_age_days,
    active_person_count, available_contact_count, socioeconomic_risk_level, active
  )
  values (
    v_fixture_debtor_id, v_fixture_debtor_id, 850, 850, 3, 3, 1, 1, 1, 1, 50, true
  );

  insert into public.debtor_profile_detail (
    id, debtor_profile, person, risk_value, reason, active
  )
  values (
    v_fixture_debtor_id, v_fixture_debtor_id, v_fixture_person_id,
    50, 'Valor inicial sintetico.', true
  );

  insert into public.data_import_authorization (
    tenant, app_user, active, can_import, can_apply, granted_by
  )
  values (
    1, v_fixture_user_id, true, true, true, v_fixture_user_id
  );

  update public.lafalda_import_control
  set apply_enabled = true,
      updated_at = now()
  where tenant = 1;

  return jsonb_build_object(
    'fixture_user_id', v_fixture_user_id,
    'fixture_person_id', v_fixture_person_id,
    'fixture_debtor_id', v_fixture_debtor_id,
    'debtor_type_id', v_debtor_type_id,
    'fixture_account', v_fixture_account,
    'currency_id', v_currency_id,
    'debt_status_id', v_debt_status_id,
    'debt_one_external_id', v_fixture_debt_one_external_id,
    'debt_two_external_id', v_fixture_debt_two_external_id,
    'debt_absent_external_id', v_fixture_debt_absent_external_id,
    'debt_new_external_id', 990000004
  );
end;
$$;

revoke all on function public.testing_prepare_lafalda_apply_fixture() from public, anon, authenticated;
revoke all on function public.testing_cleanup_lafalda_apply_fixture() from public, anon, authenticated;
grant execute on function public.testing_prepare_lafalda_apply_fixture() to service_role;
grant execute on function public.testing_cleanup_lafalda_apply_fixture() to service_role;

notify pgrst, 'reload schema';
