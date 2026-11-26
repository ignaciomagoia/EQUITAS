begin;

select public.assert_multiinstitution_platform();

-- Esta funcion solo resuelve el problema de arranque: antes de que exista un
-- administrador de plataforma no hay nadie autorizado para usar las funciones
-- administrativas de la migracion 20261123090900.
create or replace function public.bootstrap_first_platform_admin(
  p_auth_user_id uuid,
  p_full_name text
)
returns public.app_user
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text;
  v_platform_role_id bigint;
  v_user public.app_user;
begin
  perform 1
  from public.platform_installation
  where singleton
    and platform_key = 'EQUITAS_MULTIINSTITUTION'
  for update;

  if not found then
    raise exception 'La base de destino no es la plataforma multiinstitucion de EQUITAS.';
  end if;

  -- Solo puede ejecutarse antes de asignar cualquier rol de plataforma.
  -- Asi no sirve para escalar privilegios una vez inicializada la plataforma.
  if exists (select 1 from public.platform_user_role) then
    raise exception 'El bootstrap inicial ya fue ejecutado. Use la administracion normal de EQUITAS.';
  end if;

  if nullif(btrim(p_full_name), '') is null then
    raise exception 'El nombre completo del primer administrador es obligatorio.';
  end if;

  select email into v_email
  from auth.users
  where id = p_auth_user_id;

  if v_email is null then
    raise exception 'No existe el usuario de Supabase Auth indicado.';
  end if;

  select id into v_platform_role_id
  from public.platform_role
  where code = 'platform_admin'
    and active;

  if v_platform_role_id is null then
    raise exception 'No existe el rol platform_admin activo.';
  end if;

  insert into public.app_user (id, full_name, email, status)
  values (p_auth_user_id, btrim(p_full_name), v_email, 'ACTIVE')
  on conflict (id) do update
    set full_name = excluded.full_name,
        email = excluded.email,
        status = 'ACTIVE',
        updated_at = now()
  returning * into v_user;

  insert into public.platform_user_role (user_id, role_id, granted_by)
  values (p_auth_user_id, v_platform_role_id, null);

  insert into public.administration_audit_event (
    actor_user_id,
    event_type,
    subject_type,
    subject_id,
    details
  ) values (
    null,
    'PLATFORM_ADMIN_BOOTSTRAPPED',
    'APP_USER',
    p_auth_user_id::text,
    jsonb_build_object('bootstrap', true)
  );

  return v_user;
end;
$$;

-- Ningun usuario autenticado puede ejecutar este bootstrap ni otorgarse un rol.
-- Solo el SQL Editor administrado o una automatizacion con service_role pueden
-- invocarlo, y la funcion queda bloqueada despues de la primera asignacion.
revoke all on function public.bootstrap_first_platform_admin(uuid, text) from public, anon, authenticated;
grant execute on function public.bootstrap_first_platform_admin(uuid, text) to service_role;

notify pgrst, 'reload schema';

commit;
