-- SOLO LECTURA. Ejecutar exclusivamente en EQUITAS-TP-TESTING.
-- Diagnostica las tablas, RPCs, Storage y catalogos requeridos para la prueba
-- aislada de apply CSV. No crea, actualiza ni elimina registros.

with checks (kind, label, schema_name, relation_name, predicate) as (
  values
    ('TABLA', 'tenant', 'public', 'tenant', 'true'),
    ('TABLA', 'role', 'public', 'role', 'true'),
    ('TABLA', 'debtor_type', 'public', 'debtor_type', 'true'),
    ('TABLA', 'currency', 'public', 'currency', 'true'),
    ('TABLA', 'debt_status', 'public', 'debt_status', 'true'),
    ('TABLA', 'contact_type', 'public', 'contact_type', 'true'),
    ('TABLA', 'data_import_job', 'public', 'data_import_job', 'true'),
    ('TABLA', 'data_import_debt_stage', 'public', 'data_import_debt_stage', 'true'),
    ('TABLA', 'data_import_authorization', 'public', 'data_import_authorization', 'true'),
    ('TABLA', 'lafalda_import_control', 'public', 'lafalda_import_control', 'true'),
    ('TABLA', 'fixture_control', 'public', 'equitas_testing_fixture_control', 'true'),
    ('STORAGE', 'bucket privado lafalda-imports', 'storage', 'buckets', $$id = 'lafalda-imports'$$),
    ('DATO', 'tenant 1', 'public', 'tenant', 'id = 1'),
    ('DATO', 'control de importacion tenant 1', 'public', 'lafalda_import_control', 'tenant = 1'),
    ('CATALOGO', 'rol sintetico del fixture', 'public', 'role', $$name = 'equitastp_fixture_importer'$$),
    ('CATALOGO', 'tipo de objeto sintetico del fixture', 'public', 'debtor_type', $$key = 'equitastp_fixture_debtor_type'$$),
    ('CATALOGO', 'moneda ARS', 'public', 'currency', $$code = 'ARS'$$),
    ('CATALOGO', 'estado de deuda ID 2', 'public', 'debt_status', 'id = 2'),
    ('CATALOGO', 'tipo de contacto sintetico del fixture', 'public', 'contact_type', $$key = 'equitastp_fixture_contact'$$)
), evaluated as (
  select
    kind,
    label,
    schema_name,
    relation_name,
    predicate,
    to_regclass(format('%I.%I', schema_name, relation_name)) as relation_ref
  from checks
), results as (
  select
    kind,
    label,
    case
      when relation_ref is null then 'FALTA_TABLA'
      when coalesce(
        nullif(
          (xpath(
            '/row/total/text()',
            query_to_xml(
              format(
                'select count(*) as total from %I.%I where %s',
                schema_name,
                relation_name,
                predicate
              ),
              false,
              true,
              ''
            )
          ))[1]::text,
          ''
        )::bigint,
        0
      ) = 0 then 'FALTA_REGISTRO'
      else 'OK'
    end as estado
  from evaluated
), rpc_checks (kind, label, signature) as (
  values
    ('RPC', 'claim_lafalda_import_job', 'public.claim_lafalda_import_job(text,bigint)'),
    ('RPC', 'prepare_lafalda_import_stage', 'public.prepare_lafalda_import_stage(bigint)'),
    ('RPC', 'apply_lafalda_import_stage', 'public.apply_lafalda_import_stage(bigint)')
), resolved_rpcs as (
  select kind, label, to_regprocedure(signature) as procedure_ref
  from rpc_checks
)
select kind, label, estado
from results
union all
select
  kind,
  label,
  case
    when procedure_ref is null then 'FALTA_FUNCION'
    when not has_function_privilege('service_role', procedure_ref, 'EXECUTE')
      then 'SIN_PERMISO_SERVICE_ROLE'
    else 'OK'
  end
from resolved_rpcs
order by kind, label;
