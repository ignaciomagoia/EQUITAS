-- Diagnostico exclusivamente de lectura para ejecutar en EQUITAS-TP-TESTING.
-- No altera datos, funciones, politicas, Storage ni Auth.
begin read only;

select
  current_database() as database_name,
  current_user as database_role,
  current_setting('app.settings.project_ref', true) as configured_project_ref,
  now() as checked_at;

select table_schema, table_name, table_type
from information_schema.tables
where table_schema in ('public', 'auth', 'storage')
order by table_schema, table_name;

select routine_schema, routine_name, routine_type
from information_schema.routines
where routine_schema = 'public'
  and (
    routine_name ilike '%lafalda%'
    or routine_name ilike '%import%'
    or routine_name ilike '%testing%'
  )
order by routine_name;

select schemaname, tablename, policyname, roles, cmd
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

select id, name, public, file_size_limit, allowed_mime_types
from storage.buckets
order by id;

select bucket_id, count(*) as object_count
from storage.objects
group by bucket_id
order by bucket_id;

select count(*) as auth_user_count
from auth.users;

select
  count(*) filter (where table_name = 'tenant') as legacy_tenant_table,
  count(*) filter (where table_name = 'debtor') as legacy_debtor_table,
  count(*) filter (where table_name = 'debt') as legacy_debt_table,
  count(*) filter (where table_name = 'platform_installation') as multi_platform_marker
from information_schema.tables
where table_schema = 'public';

rollback;
