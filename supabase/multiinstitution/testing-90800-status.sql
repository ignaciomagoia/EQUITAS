-- Diagnostico de solo lectura posterior a un intento de 20261123090800.
begin read only;

select
  routine_schema,
  routine_name,
  data_type
from information_schema.routines
where routine_schema in ('public', 'private')
  and routine_name in (
    'can_read_import_job',
    'assert_import_job',
    'claim_multiinstitution_import_job'
  )
order by routine_schema, routine_name;

select
  tablename,
  policyname,
  cmd
from pg_policies
where schemaname = 'public'
  and tablename in (
    'import_control',
    'import_authorization',
    'import_job',
    'import_stage_row',
    'import_row_error',
    'import_change',
    'import_audit_event'
  )
order by tablename, policyname;

select
  relname as table_name,
  relrowsecurity as rls_enabled
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in (
    'import_control',
    'import_authorization',
    'import_job',
    'import_stage_row',
    'import_row_error',
    'import_change',
    'import_audit_event'
  )
order by relname;

rollback;
