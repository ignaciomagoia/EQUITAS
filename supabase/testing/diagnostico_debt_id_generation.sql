-- SOLO LECTURA. Ejecutar exclusivamente en EQUITAS-TP-TESTING.
-- Muestra como se genera public.debt.id sin modificar el esquema ni los datos.

with id_column as (
  select
    column_name,
    data_type,
    is_nullable,
    is_identity,
    identity_generation,
    column_default,
    pg_get_serial_sequence('public.debt', 'id') as sequence_name
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'debt'
    and column_name = 'id'
), debt_data as (
  select count(*) as row_count, max(id) as max_id
  from public.debt
), debt_triggers as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object('name', trigger.tgname, 'definition', pg_get_triggerdef(trigger.oid))
    ) filter (where trigger.oid is not null),
    '[]'::jsonb
  ) as triggers
  from pg_class relation
  left join pg_namespace namespace on namespace.oid = relation.relnamespace
  left join pg_trigger trigger on trigger.tgrelid = relation.oid and not trigger.tgisinternal
  where namespace.nspname = 'public'
    and relation.relname = 'debt'
)
select
  id_column.column_name,
  id_column.data_type,
  id_column.is_nullable,
  id_column.is_identity,
  id_column.identity_generation,
  id_column.column_default,
  id_column.sequence_name,
  debt_data.row_count,
  debt_data.max_id,
  debt_triggers.triggers,
  case
    when id_column.is_identity = 'YES' then 'IDENTITY'
    when id_column.column_default like 'nextval(%' then 'SEQUENCE_DEFAULT'
    when jsonb_array_length(debt_triggers.triggers) > 0 then 'REVISAR_TRIGGER'
    else 'SIN_GENERADOR'
  end as diagnostico
from id_column
cross join debt_data
cross join debt_triggers;
