begin;

select public.assert_multiinstitution_platform();

create or replace function private.can_read_import_job(p_job_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.import_job job
    where job.id = p_job_id
      and (
        job.requested_by = auth.uid()
        or private.has_institution_permission(job.institution_id, 'institution.import.create')
      )
  );
$$;

create or replace function public.assert_import_job(
  p_job_id bigint,
  p_allowed_statuses text[],
  p_require_apply boolean default false
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_institution_id bigint;
  v_mode text;
  v_status text;
  v_lock_expires_at timestamp with time zone;
begin
  perform public.assert_multiinstitution_platform();

  select institution_id, mode, status, lock_expires_at
  into v_institution_id, v_mode, v_status, v_lock_expires_at
  from public.import_job
  where id = p_job_id
  for update;

  if v_institution_id is null then
    raise exception 'Importacion inexistente: %', p_job_id;
  end if;

  if not (v_status = any(p_allowed_statuses)) then
    raise exception 'La importacion % no se encuentra en un estado valido.', p_job_id;
  end if;

  if v_lock_expires_at is null or v_lock_expires_at <= now() then
    raise exception 'El bloqueo del trabajo % no es valido.', p_job_id;
  end if;

  if p_require_apply and v_mode <> 'APPLY' then
    raise exception 'La importacion % no esta autorizada para aplicar cambios.', p_job_id;
  end if;
end;
$$;

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
    select job.id
    from public.import_job job
    join public.import_authorization ia
      on ia.institution_id = job.institution_id
    join public.institution_membership membership
      on membership.id = ia.membership_id
     and membership.institution_id = ia.institution_id
    where job.status = 'QUEUED'
      and membership.user_id = job.requested_by
      and membership.status = 'ACTIVE'
      and ia.active
      and ia.can_import
      and (job.mode = 'DRY_RUN' or (ia.can_apply and exists (
        select 1 from public.import_control control
        where control.institution_id = job.institution_id
          and control.apply_enabled
      )))
    order by job.created_at
    for update skip locked
    limit 1
  )
  update public.import_job job
  set status = 'VALIDATING',
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

alter table public.import_control enable row level security;
alter table public.import_authorization enable row level security;
alter table public.import_job enable row level security;
alter table public.import_stage_row enable row level security;
alter table public.import_row_error enable row level security;
alter table public.import_change enable row level security;
alter table public.import_audit_event enable row level security;

grant select on public.import_control, public.import_authorization, public.import_job,
  public.import_stage_row, public.import_row_error, public.import_change,
  public.import_audit_event to authenticated;

drop policy if exists import_control_select on public.import_control;
create policy import_control_select on public.import_control for select to authenticated
  using (private.has_institution_permission(institution_id, 'institution.import.create'));
drop policy if exists import_authorization_select on public.import_authorization;
create policy import_authorization_select on public.import_authorization for select to authenticated
  using (private.has_institution_permission(institution_id, 'institution.import.create'));
drop policy if exists import_job_select on public.import_job;
create policy import_job_select on public.import_job for select to authenticated
  using (requested_by = auth.uid() or private.has_institution_permission(institution_id, 'institution.import.create'));
drop policy if exists import_stage_row_select on public.import_stage_row;
create policy import_stage_row_select on public.import_stage_row for select to authenticated
  using (private.can_read_import_job(job_id));
drop policy if exists import_row_error_select on public.import_row_error;
create policy import_row_error_select on public.import_row_error for select to authenticated
  using (private.can_read_import_job(job_id));
drop policy if exists import_change_select on public.import_change;
create policy import_change_select on public.import_change for select to authenticated
  using (private.can_read_import_job(job_id));
drop policy if exists import_audit_event_select on public.import_audit_event;
create policy import_audit_event_select on public.import_audit_event for select to authenticated
  using (private.can_read_import_job(job_id));

revoke all on function private.can_read_import_job(bigint) from public, anon;
grant execute on function private.can_read_import_job(bigint) to authenticated, service_role;
revoke all on function public.assert_import_job(bigint, text[], boolean) from public, anon, authenticated;
revoke all on function public.claim_multiinstitution_import_job(text) from public, anon, authenticated;
grant execute on function public.assert_import_job(bigint, text[], boolean) to service_role;
grant execute on function public.claim_multiinstitution_import_job(text) to service_role;

notify pgrst, 'reload schema';

commit;
