begin;

select public.assert_multiinstitution_platform();

-- APPLY nunca vuelve a recibir un archivo: referencia una simulacion terminada,
-- con el mismo hash, perfil y snapshot que fueron validados previamente.
alter table public.import_job
  alter column storage_path drop not null,
  add column if not exists simulation_job_id bigint,
  add column if not exists apply_confirmed_by uuid references public.app_user(id) on delete restrict,
  add column if not exists apply_confirmed_at timestamp with time zone;

alter table public.import_job
  drop constraint if exists import_job_simulation_same_institution_fk;
alter table public.import_job
  add constraint import_job_simulation_same_institution_fk
  foreign key (simulation_job_id, institution_id)
  references public.import_job(id, institution_id) on delete restrict;

alter table public.import_job
  drop constraint if exists import_job_mode_source_check;
alter table public.import_job
  add constraint import_job_mode_source_check check (
    (mode = 'DRY_RUN' and simulation_job_id is null and apply_confirmed_by is null and apply_confirmed_at is null)
    or
    (mode = 'APPLY' and simulation_job_id is not null and apply_confirmed_by is not null and apply_confirmed_at is not null)
  );

create index if not exists import_job_simulation_idx
  on public.import_job (simulation_job_id) where simulation_job_id is not null;

drop trigger if exists import_job_dry_run_only_trigger on public.import_job;
drop function if exists public.reject_multiinstitution_apply_until_enabled();

create or replace function public.guard_multiinstitution_apply_job()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source public.import_job%rowtype;
  v_membership_id bigint;
  v_authorized boolean;
begin
  perform public.assert_multiinstitution_platform();

  if tg_op = 'UPDATE' and old.mode is distinct from new.mode then
    raise exception 'No se puede convertir una simulacion existente en una aplicacion real.';
  end if;

  if new.mode <> 'APPLY' then
    return new;
  end if;

  if new.simulation_job_id is null or new.apply_confirmed_by is null or new.apply_confirmed_at is null then
    raise exception 'Una aplicacion requiere una simulacion confirmada por el usuario.';
  end if;

  select * into v_source
  from public.import_job
  where id = new.simulation_job_id
    and institution_id = new.institution_id;

  if not found or v_source.mode <> 'DRY_RUN' or v_source.status <> 'DRY_RUN_COMPLETED' then
    raise exception 'La simulacion origen no esta disponible para aplicar cambios.';
  end if;

  if v_source.rejected_rows <> 0
     or v_source.content_sha256 <> new.content_sha256
     or v_source.profile_version_id <> new.profile_version_id
     or v_source.profile_snapshot <> new.profile_snapshot then
    raise exception 'La simulacion origen no coincide con la aplicacion solicitada.';
  end if;

  if new.requested_by <> new.apply_confirmed_by or v_source.requested_by <> new.requested_by then
    raise exception 'La aplicacion debe ser confirmada por quien solicito la simulacion.';
  end if;

  select membership.id into v_membership_id
  from public.institution_membership membership
  where membership.institution_id = new.institution_id
    and membership.user_id = new.requested_by
    and membership.status = 'ACTIVE';

  select exists (
    select 1
    from public.import_authorization authorization_row
    where authorization_row.institution_id = new.institution_id
      and authorization_row.membership_id = v_membership_id
      and authorization_row.active
      and authorization_row.can_import
      and authorization_row.can_apply
  ) into v_authorized;

  if v_membership_id is null or not coalesce(v_authorized, false) then
    raise exception 'El usuario no tiene autorizacion institucional para aplicar importaciones.';
  end if;

  if not exists (
    select 1 from public.import_control control
    where control.institution_id = new.institution_id and control.apply_enabled
  ) then
    raise exception 'La aplicacion real esta bloqueada para esta institucion.';
  end if;

  return new;
end;
$$;

create trigger import_job_apply_guard_trigger
before insert or update of mode, simulation_job_id, apply_confirmed_by, apply_confirmed_at
on public.import_job
for each row execute function public.guard_multiinstitution_apply_job();

-- Reclama tanto trabajos nuevos como recuperaciones de perfiles. Las deudas con
-- merge confirmado nunca vuelven a pasar por apply.
create or replace function public.claim_multiinstitution_import_job(p_worker_id text)
returns setof public.import_job
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.assert_multiinstitution_platform();

  update public.import_job job
  set status = case when job.status = 'UPLOADING' then 'CANCELLED' else 'FAILED' end,
      error_message = case
        when job.status = 'UPLOADING' then 'La carga privada no finalizo antes de vencer.'
        else 'El worker se interrumpio y el bloqueo vencio. El trabajo puede reintentarse.'
      end,
      lock_expires_at = null,
      completed_at = now(),
      updated_at = now()
  where job.status in ('VALIDATING', 'STAGING', 'MERGING')
    and job.merge_completed_at is null
    and job.lock_expires_at is not null
    and job.lock_expires_at <= now();

  return query
  with candidate as (
    select job.id, (job.status = 'RECALCULATING_PROFILES') as recovery
    from public.import_job job
    left join public.import_authorization authorization_row
      on authorization_row.institution_id = job.institution_id
    left join public.institution_membership membership
      on membership.id = authorization_row.membership_id
     and membership.institution_id = authorization_row.institution_id
    where (
      job.status = 'RECALCULATING_PROFILES'
      and job.mode = 'APPLY'
      and job.merge_completed_at is not null
      and job.profiles_recalculated_at is null
      and (job.lock_expires_at is null or job.lock_expires_at <= now())
    ) or (
      job.status = 'QUEUED'
      and membership.user_id = job.requested_by
      and membership.status = 'ACTIVE'
      and authorization_row.active
      and authorization_row.can_import
      and (job.mode = 'DRY_RUN' or (authorization_row.can_apply and exists (
        select 1 from public.import_control control
        where control.institution_id = job.institution_id and control.apply_enabled
      )))
    )
    order by job.created_at
    for update skip locked
    limit 1
  )
  update public.import_job job
  set status = case when candidate.recovery then 'RECALCULATING_PROFILES' else 'VALIDATING' end,
      worker_id = p_worker_id,
      lock_expires_at = now() + interval '30 minutes',
      attempt_count = job.attempt_count + 1,
      started_at = coalesce(job.started_at, now()),
      error_message = null,
      updated_at = now()
  from candidate
  where job.id = candidate.id
  returning job.*;
end;
$$;

create or replace function public.apply_multiinstitution_import_stage(p_job_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.import_job%rowtype;
  v_source public.import_job%rowtype;
  v_currency_id bigint;
  v_person_scheme_id bigint;
  v_debtor_scheme_id bigint;
  v_debt_scheme_id bigint;
  v_inserted integer := 0;
  v_updated integer := 0;
begin
  perform public.assert_multiinstitution_platform();
  perform public.assert_import_job(p_job_id, array['MERGING'], true);
  select * into v_job from public.import_job where id = p_job_id for update;
  select * into v_source from public.import_job where id = v_job.simulation_job_id for share;

  if v_source.status <> 'DRY_RUN_COMPLETED' or v_source.rejected_rows <> 0
     or v_source.content_sha256 <> v_job.content_sha256
     or v_source.profile_snapshot <> v_job.profile_snapshot then
    raise exception 'La simulacion dejo de ser valida para aplicar cambios.';
  end if;
  if exists (
    select 1
    from public.import_stage_row stage
    join public.debtor debtor
      on debtor.institution_id = v_job.institution_id
     and debtor.identity_hash = stage.debtor_identity_hash
     and debtor.identity_scheme_id = (v_job.profile_snapshot -> 'identity_scheme_ids' ->> 'debtor')::bigint
    join public.debt debt
      on debt.institution_id = debtor.institution_id
     and debt.debtor_id = debtor.id
     and debt.identity_hash = stage.debt_identity_hash
     and debt.identity_scheme_id = (v_job.profile_snapshot -> 'identity_scheme_ids' ->> 'debt')::bigint
    where stage.job_id = v_source.id
      and (debtor.updated_at > v_source.completed_at or debt.updated_at > v_source.completed_at)
  ) then
    raise exception 'Los datos cambiaron despues de la simulacion. Ejecuta una nueva simulacion antes de aplicar.';
  end if;
  if exists (select 1 from public.import_stage_row where job_id = v_source.id and validation_status <> 'VALID') then
    raise exception 'La simulacion contiene filas no validas y no se puede aplicar parcialmente.';
  end if;

  v_debtor_scheme_id := (v_job.profile_snapshot -> 'identity_scheme_ids' ->> 'debtor')::bigint;
  v_debt_scheme_id := (v_job.profile_snapshot -> 'identity_scheme_ids' ->> 'debt')::bigint;
  v_person_scheme_id := nullif(v_job.profile_snapshot -> 'identity_scheme_ids' ->> 'person', '')::bigint;
  select id into v_currency_id from public.currency where code = 'ARS' and active;
  if v_currency_id is null then raise exception 'No se encontro la moneda ARS requerida.'; end if;

  if exists (
    select 1 from public.import_stage_row stage
    where stage.job_id = v_source.id
      and not exists (
        select 1 from public.debt debt join public.debtor debtor
          on debtor.id = debt.debtor_id and debtor.institution_id = debt.institution_id
        where debt.institution_id = v_job.institution_id
          and debtor.identity_hash = stage.debtor_identity_hash and debt.identity_hash = stage.debt_identity_hash
      )
      and (nullif(stage.normalized_values ->> 'original_amount', '') is null
        or nullif(stage.normalized_values ->> 'current_amount', '') is null)
  ) then raise exception 'Una deuda nueva no contiene los importes obligatorios.'; end if;
  if exists (
    select 1 from public.import_stage_row stage
    where stage.job_id = v_source.id
      and (
        ('original_amount' = any(stage.provided_fields) and nullif(stage.normalized_values ->> 'original_amount', '') is null)
        or ('current_amount' = any(stage.provided_fields) and nullif(stage.normalized_values ->> 'current_amount', '') is null)
      )
  ) then raise exception 'Los importes presentes en el CSV no pueden estar vacios.'; end if;
  if exists (
    select 1 from public.import_stage_row stage
    where stage.job_id = v_source.id
      and 'status' = any(stage.provided_fields)
      and not exists (
        select 1 from public.institution_debt_status status
        where status.institution_id = v_job.institution_id
          and status.code = stage.normalized_values ->> 'status'
          and status.active
      )
  ) then raise exception 'El CSV contiene un estado de deuda inexistente o inactivo para la institucion.'; end if;

  -- Crear entidades ausentes usando las identidades verificadas durante el dry-run.
  insert into public.person (institution_id, identity_scheme_id, identity_hash, identity_values, external_reference, document_number, full_name, person_type_id, active)
  select v_job.institution_id, v_person_scheme_id, stage.person_identity_hash,
         jsonb_build_object('external_reference', coalesce(stage.normalized_values ->> 'person_external_reference', stage.normalized_values ->> 'person_document_number')),
         stage.normalized_values ->> 'person_external_reference', stage.normalized_values ->> 'person_document_number',
         stage.normalized_values ->> 'person_full_name', (select id from public.person_type where code = 'UNKNOWN'), true
  from public.import_stage_row stage
  where stage.job_id = v_source.id and v_person_scheme_id is not null and stage.person_identity_hash is not null
  on conflict (institution_id, identity_scheme_id, identity_hash) do nothing;

  update public.person person
  set external_reference = case when 'person_external_reference' = any(stage.provided_fields) then stage.normalized_values ->> 'person_external_reference' else person.external_reference end,
      document_number = case when 'person_document_number' = any(stage.provided_fields) then stage.normalized_values ->> 'person_document_number' else person.document_number end,
      full_name = case when 'person_full_name' = any(stage.provided_fields) then stage.normalized_values ->> 'person_full_name' else person.full_name end,
      updated_at = now()
  from public.import_stage_row stage
  where stage.job_id = v_source.id and person.institution_id = v_job.institution_id
    and person.identity_scheme_id = v_person_scheme_id and person.identity_hash = stage.person_identity_hash;

  insert into public.debtor (institution_id, object_type_id, identity_scheme_id, identity_hash, identity_values, external_reference, identifier, description, active)
  select v_job.institution_id, object_type.id, v_debtor_scheme_id, stage.debtor_identity_hash,
         jsonb_build_object('external_reference', stage.normalized_values ->> 'debtor_external_reference'),
         stage.normalized_values ->> 'debtor_external_reference', stage.normalized_values ->> 'debtor_identifier', stage.normalized_values ->> 'debtor_description', true
  from public.import_stage_row stage
  left join public.institution_object_type object_type
    on object_type.institution_id = v_job.institution_id and object_type.code = stage.normalized_values ->> 'object_type' and object_type.active
  where stage.job_id = v_source.id
  on conflict (institution_id, identity_scheme_id, identity_hash) do nothing;

  update public.debtor debtor
  set identifier = case when 'debtor_identifier' = any(stage.provided_fields) then stage.normalized_values ->> 'debtor_identifier' else debtor.identifier end,
      description = case when 'debtor_description' = any(stage.provided_fields) then stage.normalized_values ->> 'debtor_description' else debtor.description end,
      object_type_id = case when 'object_type' = any(stage.provided_fields) then object_type.id else debtor.object_type_id end,
      updated_at = now()
  from public.import_stage_row stage
  left join public.institution_object_type object_type
    on object_type.institution_id = v_job.institution_id and object_type.code = stage.normalized_values ->> 'object_type' and object_type.active
  where stage.job_id = v_source.id and debtor.institution_id = v_job.institution_id
    and debtor.identity_scheme_id = v_debtor_scheme_id and debtor.identity_hash = stage.debtor_identity_hash;

  insert into public.debtor_person (institution_id, debtor_id, person_id, active)
  select v_job.institution_id, debtor.id, person.id, true
  from public.import_stage_row stage
  join public.debtor debtor on debtor.institution_id = v_job.institution_id and debtor.identity_hash = stage.debtor_identity_hash and debtor.identity_scheme_id = v_debtor_scheme_id
  join public.person person on person.institution_id = v_job.institution_id and person.identity_hash = stage.person_identity_hash and person.identity_scheme_id = v_person_scheme_id
  where stage.job_id = v_source.id and stage.person_identity_hash is not null and v_person_scheme_id is not null
  on conflict (institution_id, debtor_id, person_id) do update set active = true, updated_at = now();

  insert into public.debtor_contact (institution_id, person_id, contact_type_id, value, active)
  select v_job.institution_id, person.id, contact_type.id, contact_value.value, true
  from public.import_stage_row stage
  join public.person person on person.institution_id = v_job.institution_id and person.identity_hash = stage.person_identity_hash and person.identity_scheme_id = v_person_scheme_id
  join lateral (values
    ('EMAIL'::text, stage.normalized_values ->> 'person_email'),
    ('PHONE'::text, stage.normalized_values ->> 'person_phone')
  ) as contact_value(code, value) on contact_value.value is not null
  join public.contact_type contact_type on contact_type.code = contact_value.code and contact_type.active
  where stage.job_id = v_source.id and stage.person_identity_hash is not null
  on conflict (institution_id, person_id, contact_type_id, value) do update set active = true, updated_at = now();

  -- Auditar el estado previo antes del merge. El identificador del stage se usa
  -- como llave, por lo que reintentar la misma aplicacion no duplica auditoria.
  insert into public.import_change (job_id, institution_id, debtor_id, debt_id, debt_identity_hash, change_type, before_values, after_values)
  select v_job.id, v_job.institution_id, debtor.id, debt.id, stage.debt_identity_hash, 'UPDATED',
         jsonb_build_object('debtor', to_jsonb(debtor), 'debt', to_jsonb(debt)),
         jsonb_build_object('normalized_values', stage.normalized_values, 'provided_fields', stage.provided_fields)
  from public.import_stage_row stage
  join public.debtor debtor on debtor.institution_id = v_job.institution_id and debtor.identity_hash = stage.debtor_identity_hash and debtor.identity_scheme_id = v_debtor_scheme_id
  join public.debt debt on debt.institution_id = v_job.institution_id and debt.debtor_id = debtor.id and debt.identity_hash = stage.debt_identity_hash and debt.identity_scheme_id = v_debt_scheme_id
  left join public.institution_debt_status status
    on status.institution_id = v_job.institution_id and status.code = stage.normalized_values ->> 'status' and status.active
  where stage.job_id = v_source.id
    and (
      ('debt_type' = any(stage.provided_fields) and debt.type is distinct from stage.normalized_values ->> 'debt_type') or
      ('debt_description' = any(stage.provided_fields) and debt.description is distinct from stage.normalized_values ->> 'debt_description') or
      ('original_amount' = any(stage.provided_fields) and debt.original_amount is distinct from (stage.normalized_values ->> 'original_amount')::numeric) or
      ('current_amount' = any(stage.provided_fields) and debt.current_amount is distinct from (stage.normalized_values ->> 'current_amount')::numeric) or
      ('issue_date' = any(stage.provided_fields) and debt.issue_date is distinct from (stage.normalized_values ->> 'issue_date')::date) or
      ('due_date' = any(stage.provided_fields) and debt.due_date is distinct from (stage.normalized_values ->> 'due_date')::date) or
      ('status' = any(stage.provided_fields) and debt.status_id is distinct from status.id) or
      ('period' = any(stage.provided_fields) and debt.period is distinct from stage.normalized_values ->> 'period')
    )
  on conflict (job_id, debtor_id, debt_identity_hash) do nothing;

  update public.debt debt
  set type = case when 'debt_type' = any(stage.provided_fields) then stage.normalized_values ->> 'debt_type' else debt.type end,
      description = case when 'debt_description' = any(stage.provided_fields) then stage.normalized_values ->> 'debt_description' else debt.description end,
      original_amount = case when 'original_amount' = any(stage.provided_fields) then (stage.normalized_values ->> 'original_amount')::numeric else debt.original_amount end,
      current_amount = case when 'current_amount' = any(stage.provided_fields) then (stage.normalized_values ->> 'current_amount')::numeric else debt.current_amount end,
      issue_date = case when 'issue_date' = any(stage.provided_fields) then (stage.normalized_values ->> 'issue_date')::date else debt.issue_date end,
      due_date = case when 'due_date' = any(stage.provided_fields) then (stage.normalized_values ->> 'due_date')::date else debt.due_date end,
      status_id = case when 'status' = any(stage.provided_fields) then status.id else debt.status_id end,
      period = case when 'period' = any(stage.provided_fields) then stage.normalized_values ->> 'period' else debt.period end,
      updated_at = now()
  from public.import_stage_row stage
  join public.debtor debtor on debtor.institution_id = v_job.institution_id and debtor.identity_hash = stage.debtor_identity_hash and debtor.identity_scheme_id = v_debtor_scheme_id
  left join public.institution_debt_status status
    on status.institution_id = v_job.institution_id and status.code = stage.normalized_values ->> 'status' and status.active
  where stage.job_id = v_source.id and debt.institution_id = v_job.institution_id
    and debt.debtor_id = debtor.id and debt.identity_hash = stage.debt_identity_hash and debt.identity_scheme_id = v_debt_scheme_id
    and (
      ('debt_type' = any(stage.provided_fields) and debt.type is distinct from stage.normalized_values ->> 'debt_type') or
      ('debt_description' = any(stage.provided_fields) and debt.description is distinct from stage.normalized_values ->> 'debt_description') or
      ('original_amount' = any(stage.provided_fields) and debt.original_amount is distinct from (stage.normalized_values ->> 'original_amount')::numeric) or
      ('current_amount' = any(stage.provided_fields) and debt.current_amount is distinct from (stage.normalized_values ->> 'current_amount')::numeric) or
      ('issue_date' = any(stage.provided_fields) and debt.issue_date is distinct from (stage.normalized_values ->> 'issue_date')::date) or
      ('due_date' = any(stage.provided_fields) and debt.due_date is distinct from (stage.normalized_values ->> 'due_date')::date) or
      ('status' = any(stage.provided_fields) and debt.status_id is distinct from status.id) or
      ('period' = any(stage.provided_fields) and debt.period is distinct from stage.normalized_values ->> 'period')
    );
  get diagnostics v_updated = row_count;

  insert into public.debt (institution_id, debtor_id, identity_scheme_id, identity_hash, identity_values, external_reference, type, description, original_amount, current_amount, currency_id, issue_date, due_date, status_id, period, active)
  select v_job.institution_id, debtor.id, v_debt_scheme_id, stage.debt_identity_hash,
         jsonb_build_object('external_reference', stage.normalized_values ->> 'debt_external_reference'),
         stage.normalized_values ->> 'debt_external_reference', stage.normalized_values ->> 'debt_type', stage.normalized_values ->> 'debt_description',
         (stage.normalized_values ->> 'original_amount')::numeric, (stage.normalized_values ->> 'current_amount')::numeric, v_currency_id,
         (stage.normalized_values ->> 'issue_date')::date, (stage.normalized_values ->> 'due_date')::date, status.id, stage.normalized_values ->> 'period', true
  from public.import_stage_row stage
  join public.debtor debtor on debtor.institution_id = v_job.institution_id and debtor.identity_hash = stage.debtor_identity_hash and debtor.identity_scheme_id = v_debtor_scheme_id
  left join public.institution_debt_status status
    on status.institution_id = v_job.institution_id and status.code = stage.normalized_values ->> 'status' and status.active
  where stage.job_id = v_source.id
  on conflict (institution_id, debtor_id, identity_scheme_id, identity_hash) do nothing;
  get diagnostics v_inserted = row_count;

  insert into public.import_change (job_id, institution_id, debtor_id, debt_id, debt_identity_hash, change_type, before_values, after_values)
  select v_job.id, v_job.institution_id, debtor.id, debt.id, stage.debt_identity_hash, 'INSERTED', null,
         jsonb_build_object('debtor', to_jsonb(debtor), 'debt', to_jsonb(debt))
  from public.import_stage_row stage
  join public.debtor debtor on debtor.institution_id = v_job.institution_id and debtor.identity_hash = stage.debtor_identity_hash and debtor.identity_scheme_id = v_debtor_scheme_id
  join public.debt debt on debt.institution_id = v_job.institution_id and debt.debtor_id = debtor.id and debt.identity_hash = stage.debt_identity_hash and debt.identity_scheme_id = v_debt_scheme_id
  where stage.job_id = v_source.id
    and not exists (select 1 from public.import_change change_row where change_row.job_id = v_job.id and change_row.debtor_id = debtor.id and change_row.debt_identity_hash = stage.debt_identity_hash)
  on conflict (job_id, debtor_id, debt_identity_hash) do nothing;

  update public.import_job
  set merge_completed_at = now(), inserted_rows = v_inserted, updated_rows = v_updated,
      unchanged_rows = greatest(0, v_source.unchanged_rows), processed_rows = v_source.processed_rows,
      total_rows = v_source.total_rows, rejected_rows = 0, updated_at = now()
  where id = v_job.id;

  return jsonb_build_object('inserted_rows', v_inserted, 'updated_rows', v_updated, 'source_job_id', v_source.id);
end;
$$;

create or replace function public.recalculate_multiinstitution_import_profiles(p_job_id bigint)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.import_job%rowtype;
begin
  perform public.assert_multiinstitution_platform();
  perform public.assert_import_job(p_job_id, array['RECALCULATING_PROFILES'], true);
  select * into v_job from public.import_job where id = p_job_id for update;
  if v_job.merge_completed_at is null then raise exception 'No se pueden recalcular perfiles antes del merge.'; end if;

  with affected as (
    select distinct debtor_id from public.import_change where job_id = v_job.id
    union
    select debtor.id
    from public.import_stage_row stage
    join public.debtor debtor
      on debtor.institution_id = v_job.institution_id
     and debtor.identity_hash = stage.debtor_identity_hash
     and debtor.identity_scheme_id = (v_job.profile_snapshot -> 'identity_scheme_ids' ->> 'debtor')::bigint
    where stage.job_id = v_job.simulation_job_id
  ), metrics as (
    select debt.institution_id, debt.debtor_id,
      coalesce(sum(debt.current_amount) filter (where debt.active), 0) as total_amount,
      coalesce(sum(debt.current_amount) filter (where debt.active and debt.due_date < current_date), 0) as overdue_amount,
      count(*) filter (where debt.active)::integer as debt_count,
      count(*) filter (where debt.active and debt.due_date < current_date)::integer as overdue_count,
      coalesce(max(greatest(0, current_date - debt.due_date)) filter (where debt.active and debt.due_date is not null), 0)::integer as oldest_days,
      coalesce(avg(greatest(0, current_date - debt.issue_date)) filter (where debt.active and debt.issue_date is not null), 0)::integer as average_days
    from public.debt debt join affected on affected.debtor_id = debt.debtor_id
    where debt.institution_id = v_job.institution_id group by debt.institution_id, debt.debtor_id
  ), contacts as (
    select relation.debtor_id, count(contact.id)::integer as available_contacts
    from public.debtor_person relation left join public.debtor_contact contact
      on contact.institution_id = relation.institution_id and contact.person_id = relation.person_id and contact.active
    where relation.institution_id = v_job.institution_id and relation.active
    group by relation.debtor_id
  )
  insert into public.debtor_profile (institution_id, debtor_id, total_debt_amount, overdue_debt_amount, debt_count, overdue_debt_count, oldest_debt_days, average_debt_age_days, active_person_count, available_contact_count, socioeconomic_risk_level, profile_generated_at, active)
  select metrics.institution_id, metrics.debtor_id, metrics.total_amount, metrics.overdue_amount, metrics.debt_count, metrics.overdue_count, metrics.oldest_days, metrics.average_days,
         (select count(*)::integer from public.debtor_person relation where relation.institution_id = metrics.institution_id and relation.debtor_id = metrics.debtor_id and relation.active),
         coalesce(contacts.available_contacts, 0),
         least(100, greatest(0, (case when metrics.overdue_amount > 0 then 45 else 5 end) + (case when metrics.oldest_days > 90 then 25 else 0 end) + (case when coalesce(contacts.available_contacts, 0) = 0 then 20 else 0 end)))::integer,
         now(), true
  from metrics left join contacts on contacts.debtor_id = metrics.debtor_id
  on conflict (institution_id, debtor_id) do update set
    total_debt_amount = excluded.total_debt_amount, overdue_debt_amount = excluded.overdue_debt_amount,
    debt_count = excluded.debt_count, overdue_debt_count = excluded.overdue_debt_count,
    oldest_debt_days = excluded.oldest_debt_days, average_debt_age_days = excluded.average_debt_age_days,
    active_person_count = excluded.active_person_count, available_contact_count = excluded.available_contact_count,
    socioeconomic_risk_level = excluded.socioeconomic_risk_level, profile_generated_at = excluded.profile_generated_at, active = true;

  insert into public.debtor_profile_detail (institution_id, debtor_profile_id, person_id, risk_value, reason, active)
  select profile.institution_id, profile.id, relation.person_id, profile.socioeconomic_risk_level,
         'Recalculado luego de una importacion CSV.', true
  from public.debtor_profile profile join public.debtor_person relation
    on relation.institution_id = profile.institution_id and relation.debtor_id = profile.debtor_id and relation.active
  join (
    select distinct debtor_id from public.import_change where job_id = v_job.id
    union
    select debtor.id from public.import_stage_row stage join public.debtor debtor
      on debtor.institution_id = v_job.institution_id
     and debtor.identity_hash = stage.debtor_identity_hash
     and debtor.identity_scheme_id = (v_job.profile_snapshot -> 'identity_scheme_ids' ->> 'debtor')::bigint
    where stage.job_id = v_job.simulation_job_id
  ) affected on affected.debtor_id = profile.debtor_id
  where profile.institution_id = v_job.institution_id
  on conflict (institution_id, debtor_profile_id, person_id) do update set risk_value = excluded.risk_value, reason = excluded.reason, active = true;

  update public.import_job
  set profiles_recalculated_at = now(), profile_recalculation_error = null,
      profile_recalculation_attempt_count = profile_recalculation_attempt_count + 1,
      status = 'COMPLETED', completed_at = now(), updated_at = now()
  where id = v_job.id;
end;
$$;

revoke all on function public.guard_multiinstitution_apply_job() from public, anon, authenticated;
revoke all on function public.apply_multiinstitution_import_stage(bigint) from public, anon, authenticated;
revoke all on function public.recalculate_multiinstitution_import_profiles(bigint) from public, anon, authenticated;
revoke all on function public.claim_multiinstitution_import_job(text) from public, anon, authenticated;
grant execute on function public.guard_multiinstitution_apply_job() to service_role;
grant execute on function public.apply_multiinstitution_import_stage(bigint) to service_role;
grant execute on function public.recalculate_multiinstitution_import_profiles(bigint) to service_role;
grant execute on function public.claim_multiinstitution_import_job(text) to service_role;

notify pgrst, 'reload schema';
commit;
