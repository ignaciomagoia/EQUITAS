begin;

select public.assert_multiinstitution_platform();

-- La recuperacion de perfiles usa LEFT JOIN porque no necesita volver a
-- autorizar un merge ya confirmado. PostgreSQL no permite FOR UPDATE sobre el
-- lado nullable de ese join; se bloquea exclusivamente la fila import_job.
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
    for update of job skip locked
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

revoke all on function public.claim_multiinstitution_import_job(text) from public, anon, authenticated;
grant execute on function public.claim_multiinstitution_import_job(text) to service_role;

notify pgrst, 'reload schema';
commit;
