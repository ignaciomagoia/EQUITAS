-- Plataforma EQUITAS multiinstitucion. Solo para un proyecto Supabase vacio.
-- No ejecutar en el proyecto historico de La Falda.
--
-- Supabase SQL Editor no concede permiso para ALTER DATABASE SET; por eso la
-- autorizacion se basa en invariantes persistentes y no en variables de sesion:
-- el esquema publico/privado debe estar vacio y no deben existir datos legados.

do $$
begin
  if to_regclass('public.tenant') is not null
     or to_regclass('public.debtor') is not null
     or to_regclass('public.debt') is not null then
    raise exception 'Instalacion bloqueada: se detecto un esquema operativo historico de EQUITAS.';
  end if;

  if to_regclass('public.platform_installation') is not null then
    raise exception 'Instalacion bloqueada: la base ya posee un marcador de plataforma.';
  end if;

  if exists (
    select 1
    from pg_class
    where relnamespace = 'public'::regnamespace
  ) or exists (
    select 1
    from pg_proc
    where pronamespace = 'public'::regnamespace
  ) then
    raise exception 'Instalacion bloqueada: el esquema public no esta vacio.';
  end if;

  if to_regnamespace('private') is not null then
    raise exception 'Instalacion bloqueada: el esquema private heredado debe eliminarse antes de instalar.';
  end if;

  if exists (select 1 from storage.buckets)
     or exists (select 1 from storage.objects)
     or exists (select 1 from auth.users) then
    raise exception 'Instalacion bloqueada: Storage o Auth aun contienen datos del entorno anterior.';
  end if;
end;
$$;

create table public.platform_installation (
  singleton boolean primary key default true check (singleton),
  platform_key text not null unique check (platform_key = 'EQUITAS_MULTIINSTITUTION'),
  schema_version integer not null default 1 check (schema_version > 0),
  installed_at timestamp with time zone not null default now()
);

insert into public.platform_installation (singleton, platform_key)
values (true, 'EQUITAS_MULTIINSTITUTION');

create or replace function public.assert_multiinstitution_platform()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_platform_key text;
begin
  select platform_key into v_platform_key
  from public.platform_installation
  where singleton;

  if v_platform_key is distinct from 'EQUITAS_MULTIINSTITUTION' then
    raise exception 'La base de destino no es la plataforma multiinstitucion de EQUITAS.';
  end if;
end;
$$;

revoke all on public.platform_installation from public, anon, authenticated;
revoke all on function public.assert_multiinstitution_platform() from public, anon, authenticated;
grant all on public.platform_installation to service_role;
grant execute on function public.assert_multiinstitution_platform() to service_role;

alter table public.platform_installation enable row level security;

notify pgrst, 'reload schema';
