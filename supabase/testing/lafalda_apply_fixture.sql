-- SOLO PARA EQUITAS-TP-TESTING.
-- No ejecutar en el proyecto de produccion ni incluir en las migraciones generales.
-- Requiere aplicar previamente, en orden, todos los archivos de supabase/migrations.

create table if not exists public.equitas_testing_fixture_control (
  id boolean primary key default true check (id),
  environment_label text not null check (environment_label = 'EQUITAS-TP-TESTING'),
  updated_at timestamp with time zone not null default now()
);

insert into public.equitas_testing_fixture_control (id, environment_label)
values (true, 'EQUITAS-TP-TESTING')
on conflict (id) do update
set environment_label = excluded.environment_label,
    updated_at = now();

create or replace function public.testing_prepare_lafalda_apply_fixture()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
    from public.equitas_testing_fixture_control
    where id and environment_label = 'EQUITAS-TP-TESTING'
  ) then
    raise exception 'Fixture de testing no habilitado para este proyecto.';
  end if;

  delete from public.data_import_job where tenant = 1;
  delete from public.debtor where id = 1001;
  delete from public.person where id = 1001;
  delete from public.tenant_user where "user" = 1001;
  delete from public.data_import_authorization where tenant = 1 and app_user = 1001;
  delete from public."user" where id = 1001;

  insert into public.tenant (id, name, legal_name, status)
  values (1, 'Municipio de Prueba', 'EQUITAS-TP-TESTING', 'ACTIVE')
  on conflict (id) do update
  set name = excluded.name,
      legal_name = excluded.legal_name,
      status = excluded.status;

  insert into public.role (id, name, description)
  values (1, 'testing_importer', 'Rol sintetico para integracion CSV')
  on conflict (id) do update
  set name = excluded.name,
      description = excluded.description;

  insert into public.debtor_type (id, key, value, active)
  values (1, 'inmueble', 'Inmueble', true)
  on conflict (id) do update
  set key = excluded.key,
      value = excluded.value,
      active = excluded.active;

  insert into public.currency (id, code, name, active)
  values (1, 'ARS', 'Peso argentino de prueba', true)
  on conflict (id) do update
  set code = excluded.code,
      name = excluded.name,
      active = excluded.active;

  insert into public.debt_status (id, key, value, description, active)
  values (2, 'vencida', 'Vencida', 'Estado sintetico de prueba', true)
  on conflict (id) do update
  set key = excluded.key,
      value = excluded.value,
      description = excluded.description,
      active = excluded.active;

  insert into public.contact_type (id, key, value, priority, active)
  values (1, 'email', 'Email', 1, true)
  on conflict (id) do update
  set key = excluded.key,
      value = excluded.value,
      priority = excluded.priority,
      active = excluded.active;

  insert into public."user" (id, full_name, email, status)
  values (1001, 'Usuario de prueba', 'testing-importer@example.test', 'ACTIVE');

  insert into public.tenant_user (id, tenant, "user", role, status)
  values (1001, 1, 1001, 1, true);

  insert into public.person (id, external_id, document_number, full_name)
  values (1001, 1001, 'TEST-1001', 'Persona sintetica de prueba');

  insert into public.debtor (id, tenant, external_id, type, identifier, description, status)
  values (1001, 1, 700001, 1, 'TEST-700001', 'Objeto sintetico de prueba', true);

  insert into public.debtor_person (id, debtor, person, priority, role, active)
  values (1001, 1001, 1001, 100, 'Responsable de prueba', true);

  insert into public.debtor_contact (id, person, type, value, active)
  values (1001, 1001, 1, 'person@example.test', true);

  insert into public.debt (
    id, external_id, debtor, type, description, original_amount, current_amount,
    currency, issue_date, due_date, last_collection_date, period, status
  )
  values
    (1001, 900001, 1001, 'inmueble', 'Deuda actualizable', 80, 100, 1, '2025-01-01', '2025-02-01', '2025-02-15', '2025-01', 2),
    (1002, 900002, 1001, 'inmueble', 'Deuda parcial', 200, 250, 1, '2025-01-01', '2025-02-01', '2025-02-15', '2025-01', 2),
    (1003, 900003, 1001, 'inmueble', 'Deuda ausente que se conserva', 400, 500, 1, '2025-01-01', '2025-02-01', '2025-02-15', '2025-01', 2);

  insert into public.debtor_profile (
    id, debtor, total_debt_amount, overdue_debt_amount, debt_count,
    overdue_debt_count, oldest_debt_days, average_debt_age_days,
    active_person_count, available_contact_count, socioeconomic_risk_level, active
  )
  values (1001, 1001, 850, 850, 3, 3, 1, 1, 1, 1, 50, true);

  insert into public.debtor_profile_detail (
    id, debtor_profile, person, risk_value, reason, active
  )
  values (1001, 1001, 1001, 50, 'Valor inicial sintetico.', true);

  insert into public.data_import_authorization (
    tenant, app_user, active, can_import, can_apply, granted_by
  )
  values (1, 1001, true, true, true, 1001);

  update public.lafalda_import_control
  set apply_enabled = true,
      updated_at = now()
  where tenant = 1;
end;
$$;

create or replace function public.testing_cleanup_lafalda_apply_fixture()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
    from public.equitas_testing_fixture_control
    where id and environment_label = 'EQUITAS-TP-TESTING'
  ) then
    raise exception 'Fixture de testing no habilitado para este proyecto.';
  end if;

  update public.lafalda_import_control
  set apply_enabled = false,
      updated_at = now()
  where tenant = 1;

  delete from public.data_import_job where tenant = 1;
  delete from public.debtor where id = 1001;
  delete from public.person where id = 1001;
  delete from public.tenant_user where "user" = 1001;
  delete from public.data_import_authorization where tenant = 1 and app_user = 1001;
  delete from public."user" where id = 1001;
end;
$$;

revoke all on function public.testing_prepare_lafalda_apply_fixture() from public, anon, authenticated;
revoke all on function public.testing_cleanup_lafalda_apply_fixture() from public, anon, authenticated;
grant execute on function public.testing_prepare_lafalda_apply_fixture() to service_role;
grant execute on function public.testing_cleanup_lafalda_apply_fixture() to service_role;

notify pgrst, 'reload schema';
