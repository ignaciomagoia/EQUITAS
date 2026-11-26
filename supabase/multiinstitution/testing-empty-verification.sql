-- Diagnostico de solo lectura posterior al reset de EQUITAS-TP-TESTING.
begin read only;

select table_schema, table_name
from information_schema.tables
where table_schema = 'public'
order by table_name;

select routine_schema, routine_name
from information_schema.routines
where routine_schema = 'public'
order by routine_name;

select count(*) as auth_user_count
from auth.users;

select count(*) as storage_bucket_count
from storage.buckets;

select count(*) as storage_object_count
from storage.objects;

select
  to_regclass('public.tenant') as legacy_tenant,
  to_regclass('public.debtor') as legacy_debtor,
  to_regclass('public.debt') as legacy_debt,
  to_regclass('public.platform_installation') as multi_marker,
  to_regnamespace('private') as private_schema;

rollback;
