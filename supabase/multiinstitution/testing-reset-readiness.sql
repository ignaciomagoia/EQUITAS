-- Diagnostico de solo lectura antes del reset de EQUITAS-TP-TESTING.
-- Confirmar manualmente en el encabezado del Dashboard el project ref
-- iylwghgvtydpmwidojdo antes de ejecutar cualquier script destructivo.
begin read only;

select
  current_database() as database_name,
  current_user as database_role,
  now() as checked_at;

do $$
declare
  v_fixture_count integer;
begin
  if to_regclass('public.debt') is null then
    raise notice 'expected_fixture_debt_count = N/A (public.debt ya no existe)';
  else
    execute 'select count(*) from public.debt where id in (910001, 910002)'
      into v_fixture_count;
    raise notice 'expected_fixture_debt_count = %', v_fixture_count;
  end if;
end;
$$;

select count(*) as storage_bucket_count
from storage.buckets;

select count(*) as storage_object_count
from storage.objects;

select count(*) as auth_user_count
from auth.users;

select
  to_regclass('public.tenant') as legacy_tenant,
  to_regclass('public.debtor') as legacy_debtor,
  to_regclass('public.debt') as legacy_debt,
  to_regclass('public.platform_installation') as multi_marker,
  to_regnamespace('private') as private_schema;

rollback;
