begin;

select public.assert_multiinstitution_platform();

-- El resumen se conserva fuera del perfil/mapeo para que la simulacion pueda
-- mostrar personas, objetos y deudas sin tocar el dominio operativo.
alter table public.import_job
  add column if not exists dry_run_summary jsonb not null default '{}'::jsonb
  check (jsonb_typeof(dry_run_summary) = 'object');

-- Multiinstitucion se habilita primero solo para simulaciones. Este trigger es
-- una barrera de base de datos incluso para llamadas con service_role; APPLY
-- requerira una migracion posterior, auditada y deliberada para retirarla.
create or replace function public.reject_multiinstitution_apply_until_enabled()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.mode = 'APPLY' then
    raise exception 'Las importaciones APPLY de Multiinstitucion no estan habilitadas.';
  end if;
  return new;
end;
$$;

drop trigger if exists import_job_dry_run_only_trigger on public.import_job;
create trigger import_job_dry_run_only_trigger
before insert or update of mode on public.import_job
for each row execute function public.reject_multiinstitution_apply_until_enabled();

revoke all on function public.reject_multiinstitution_apply_until_enabled() from public, anon, authenticated;
grant execute on function public.reject_multiinstitution_apply_until_enabled() to service_role;

notify pgrst, 'reload schema';

commit;
