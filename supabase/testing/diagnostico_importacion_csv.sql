-- Diagnostico SOLO LECTURA para EQUITAS-TP-TESTING.
-- No crea, modifica ni elimina tablas, datos, funciones, permisos o Storage.
-- Ejecutar como una unica consulta en SQL Editor y conservar el resultado.

with expected_tables(section, table_name, requires_rls, service_role_select) as (
  values
    ('WORKER_BASE', 'tenant', true, true),
    ('WORKER_BASE', 'user', true, true),
    ('WORKER_BASE', 'tenant_user', true, true),
    ('WORKER_BASE', 'debtor', true, true),
    ('WORKER_BASE', 'debt', true, true),
    ('WORKER_BASE', 'debtor_person', true, true),
    ('WORKER_BASE', 'debtor_contact', true, true),
    ('WORKER_BASE', 'debtor_profile', true, true),
    ('WORKER_BASE', 'debtor_profile_detail', true, true),
    ('IMPORTACION', 'data_import_job', true, true),
    ('IMPORTACION', 'data_import_debt_stage', true, true),
    ('IMPORTACION', 'data_import_row_error', true, true),
    ('IMPORTACION', 'lafalda_import_control', true, false),
    ('AUTORIZACION_AUDITORIA', 'data_import_authorization', true, true),
    ('AUTORIZACION_AUDITORIA', 'data_import_audit_event', true, true),
    ('AUTORIZACION_AUDITORIA', 'data_import_debt_change', true, true)
),
table_state as (
  select
    expected.section,
    expected.table_name,
    expected.requires_rls,
    expected.service_role_select,
    relation.oid,
    relation.relrowsecurity,
    coalesce(has_table_privilege('service_role', relation.oid, 'SELECT'), false) as service_role_can_select
  from expected_tables expected
  left join pg_class relation
    on relation.relname = expected.table_name
   and relation.relnamespace = 'public'::regnamespace
   and relation.relkind in ('r', 'p')
),
expected_columns(table_name, column_name, expected_type) as (
  values
    ('tenant', 'id', 'bigint'),
    ('user', 'id', 'bigint'),
    ('user', 'auth_user', 'uuid'),
    ('tenant_user', 'tenant', 'bigint'),
    ('tenant_user', 'user', 'bigint'),
    ('tenant_user', 'status', 'boolean'),
    ('debtor', 'id', 'bigint'),
    ('debtor', 'tenant', 'bigint'),
    ('debtor', 'external_id', 'bigint'),
    ('debtor', 'type', 'bigint'),
    ('debt', 'id', 'bigint'),
    ('debt', 'external_id', 'bigint'),
    ('debt', 'debtor', 'bigint'),
    ('debt', 'type', 'text'),
    ('debt', 'description', 'text'),
    ('debt', 'original_amount', 'numeric'),
    ('debt', 'current_amount', 'numeric'),
    ('debt', 'currency', 'bigint'),
    ('debt', 'issue_date', 'date'),
    ('debt', 'due_date', 'date'),
    ('debt', 'last_collection_date', 'date'),
    ('debt', 'period', 'text'),
    ('debt', 'status', 'bigint'),
    ('debtor_person', 'debtor', 'bigint'),
    ('debtor_person', 'person', 'bigint'),
    ('debtor_person', 'priority', 'numeric'),
    ('debtor_person', 'role', 'text'),
    ('debtor_person', 'active', 'boolean'),
    ('debtor_contact', 'person', 'bigint'),
    ('debtor_contact', 'id', 'bigint'),
    ('debtor_contact', 'active', 'boolean'),
    ('debtor_profile', 'id', 'bigint'),
    ('debtor_profile', 'debtor', 'bigint'),
    ('debtor_profile', 'total_debt_amount', 'numeric'),
    ('debtor_profile', 'socioeconomic_risk_level', 'integer'),
    ('debtor_profile_detail', 'id', 'bigint'),
    ('debtor_profile_detail', 'debtor_profile', 'bigint'),
    ('debtor_profile_detail', 'person', 'bigint')
),
missing_or_incompatible_columns as (
  select
    expected.table_name,
    expected.column_name,
    expected.expected_type,
    actual.data_type
  from expected_columns expected
  left join information_schema.columns actual
    on actual.table_schema = 'public'
   and actual.table_name = expected.table_name
   and actual.column_name = expected.column_name
  where actual.column_name is null or actual.data_type <> expected.expected_type
),
expected_functions(section, signature, service_role_execute) as (
  values
    ('IMPORTACION', 'claim_lafalda_import_job(text,bigint)', true),
    ('IMPORTACION', 'prepare_lafalda_import_stage(bigint)', true),
    ('IMPORTACION', 'summarize_lafalda_import_stage(bigint)', true),
    ('IMPORTACION', 'apply_lafalda_import_stage(bigint)', true),
    ('IMPORTACION', 'assert_lafalda_import_job(bigint,text[],boolean)', false),
    ('AUTORIZACION_AUDITORIA', 'assert_lafalda_import_requester_authorized(bigint,boolean)', false),
    ('AUTORIZACION_AUDITORIA', 'record_lafalda_import_audit_event()', false)
),
function_state as (
  select
    expected.section,
    expected.signature,
    expected.service_role_execute,
    procedure.oid,
    procedure.prosecdef,
    coalesce(has_function_privilege('service_role', procedure.oid, 'EXECUTE'), false) as service_role_can_execute
  from expected_functions expected
  left join pg_proc procedure
    on procedure.pronamespace = 'public'::regnamespace
   and procedure.oid::regprocedure::text = expected.signature
),
expected_constraints(table_name, definition_fragment) as (
  values
    ('debtor', 'UNIQUE (tenant, type, external_id)'),
    ('debt', 'UNIQUE (debtor, external_id)')
),
constraint_state as (
  select
    expected.table_name,
    expected.definition_fragment,
    exists (
      select 1
      from pg_constraint constraint_row
      join pg_class relation on relation.oid = constraint_row.conrelid
      where relation.relnamespace = 'public'::regnamespace
        and relation.relname = expected.table_name
        and pg_get_constraintdef(constraint_row.oid) like '%' || expected.definition_fragment || '%'
    ) as exists
  from expected_constraints expected
),
storage_state as (
  select
    bucket.id,
    bucket.public,
    bucket.file_size_limit,
    bucket.allowed_mime_types
  from (values ('lafalda-imports'::text)) expected(id)
  left join storage.buckets bucket on bucket.id = expected.id
),
fixture_state as (
  select exists (
    select 1
    from pg_proc procedure
    where procedure.pronamespace = 'public'::regnamespace
      and procedure.oid::regprocedure::text = 'testing_prepare_lafalda_apply_fixture()'
  ) as exists
)
select
  state.section,
  state.table_name as target,
  case
    when state.oid is null then 'FALTA'
    when state.requires_rls and not state.relrowsecurity then 'INCOMPATIBLE'
    when state.service_role_select and not state.service_role_can_select then 'INCOMPATIBLE'
    when not state.service_role_select and state.service_role_can_select then 'REVISAR_PERMISO'
    else 'OK'
  end as estado,
  case
    when state.oid is null then 'Tabla ausente.'
    when state.requires_rls and not state.relrowsecurity then 'RLS no esta habilitado.'
    when state.service_role_select and not state.service_role_can_select then 'service_role no puede leer la tabla requerida por worker/API.'
    when not state.service_role_select and state.service_role_can_select then 'service_role puede leer un control que deberia quedar cerrado.'
    else 'Tabla, RLS y permiso esperados presentes.'
  end as detalle
from table_state state

union all

select
  'COLUMNAS_WORKER',
  format('%I.%I', issue.table_name, issue.column_name),
  'INCOMPATIBLE',
  format('Se esperaba tipo %s; se encontro %s.', issue.expected_type, coalesce(issue.data_type, 'COLUMNA_AUSENTE'))
from missing_or_incompatible_columns issue

union all

select
  state.section,
  state.signature,
  case
    when state.oid is null then 'FALTA'
    when not state.prosecdef then 'INCOMPATIBLE'
    when state.service_role_execute and not state.service_role_can_execute then 'INCOMPATIBLE'
    when not state.service_role_execute and state.service_role_can_execute then 'REVISAR_PERMISO'
    else 'OK'
  end,
  case
    when state.oid is null then 'RPC o funcion auxiliar ausente.'
    when not state.prosecdef then 'La funcion debe ser SECURITY DEFINER.'
    when state.service_role_execute and not state.service_role_can_execute then 'service_role no puede ejecutar la RPC requerida.'
    when not state.service_role_execute and state.service_role_can_execute then 'La funcion interna no deberia exponerse a service_role.'
    else 'Funcion, SECURITY DEFINER y permiso esperados presentes.'
  end
from function_state state

union all

select
  'CLAVES_ESTABLES',
  format('%I: %s', state.table_name, state.definition_fragment),
  case when state.exists then 'OK' else 'INCOMPATIBLE' end,
  case when state.exists then 'Restriccion unica presente.' else 'Falta la restriccion unica requerida para idempotencia.' end
from constraint_state state

union all

select
  'STORAGE',
  'lafalda-imports',
  case
    when state.id is null then 'FALTA'
    when state.public then 'INCOMPATIBLE'
    when state.file_size_limit <> 104857600 then 'REVISAR_CONFIGURACION'
    when state.allowed_mime_types is distinct from array['text/csv'] then 'REVISAR_CONFIGURACION'
    else 'OK'
  end,
  case
    when state.id is null then 'Bucket privado requerido por el worker ausente.'
    when state.public then 'El bucket no es privado.'
    else format('Bucket presente; limite=%s; MIME=%s.', state.file_size_limit, state.allowed_mime_types)
  end
from storage_state state

union all

select
  'FIXTURE_TESTING',
  'testing_prepare_lafalda_apply_fixture()',
  case when state.exists then 'OK' else 'PENDIENTE' end,
  case when state.exists then 'Fixture sintetico instalado.' else 'Instalar solamente despues de validar importaciones y autorizacion.' end
from fixture_state state

union all

select
  'DATOS_SINTETICOS',
  'debt.id 910001 y 910002',
  case when count(*) = 2 then 'OK' else 'REVISAR_DATOS' end,
  format('Coincidencias encontradas: %s.', count(*))
from public.debt
where id in (910001, 910002)

order by 1, 2;
