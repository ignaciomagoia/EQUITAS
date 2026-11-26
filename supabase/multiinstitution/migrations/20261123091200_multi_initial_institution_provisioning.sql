begin;

select public.assert_multiinstitution_platform();

-- Provision controlada para el primer piloto institucional. No asigna ningun
-- rol de plataforma y solo se permite sobre una plataforma aun sin instituciones.
create or replace function public.provision_initial_institution_admin(
  p_auth_user_id uuid,
  p_full_name text,
  p_institution_slug text,
  p_institution_name text,
  p_legal_name text default null,
  p_institution_type text default 'UNIVERSITY'
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text;
  v_institution_id bigint;
  v_membership_id bigint;
  v_institution_admin_role_id bigint;
begin
  perform 1
  from public.platform_installation
  where singleton
    and platform_key = 'EQUITAS_MULTIINSTITUTION'
  for update;

  if not found then
    raise exception 'La base de destino no es la plataforma multiinstitucion de EQUITAS.';
  end if;

  if exists (select 1 from public.institution)
     or exists (select 1 from public.institution_membership) then
    raise exception 'La provision inicial ya fue ejecutada. Use la administracion normal de EQUITAS.';
  end if;

  if exists (select 1 from public.platform_user_role) then
    raise exception 'Ya existe un administrador global. Use la administracion normal de EQUITAS.';
  end if;

  if nullif(btrim(p_full_name), '') is null
     or nullif(btrim(p_institution_slug), '') is null
     or nullif(btrim(p_institution_name), '') is null then
    raise exception 'El usuario, slug y nombre de la institucion son obligatorios.';
  end if;

  select email into v_email
  from auth.users
  where id = p_auth_user_id;

  if v_email is null then
    raise exception 'No existe el usuario de Supabase Auth indicado.';
  end if;

  select id into v_institution_admin_role_id
  from public.institution_role
  where code = 'institution_admin'
    and active;

  if v_institution_admin_role_id is null then
    raise exception 'No existe el rol institution_admin activo.';
  end if;

  insert into public.app_user (id, full_name, email, status)
  values (p_auth_user_id, btrim(p_full_name), v_email, 'ACTIVE');

  insert into public.institution (slug, name, legal_name, institution_type)
  values (
    lower(btrim(p_institution_slug)),
    btrim(p_institution_name),
    nullif(btrim(p_legal_name), ''),
    coalesce(nullif(btrim(p_institution_type), ''), 'UNIVERSITY')
  )
  returning id into v_institution_id;

  insert into public.import_control (institution_id, apply_enabled)
  values (v_institution_id, false);

  insert into public.institution_membership (institution_id, user_id, status, granted_by)
  values (v_institution_id, p_auth_user_id, 'ACTIVE', null)
  returning id into v_membership_id;

  insert into public.institution_membership_role (membership_id, institution_id, role_id, granted_by)
  values (v_membership_id, v_institution_id, v_institution_admin_role_id, null);

  insert into public.user_active_institution (user_id, institution_id)
  values (p_auth_user_id, v_institution_id);

  insert into public.import_authorization (
    institution_id, membership_id, can_import, can_apply, active, granted_by
  ) values (
    v_institution_id, v_membership_id, true, false, true, null
  );

  insert into public.administration_audit_event (
    actor_user_id, institution_id, event_type, subject_type, subject_id, details
  ) values (
    null, v_institution_id, 'INITIAL_INSTITUTION_ADMIN_PROVISIONED',
    'APP_USER', p_auth_user_id::text,
    jsonb_build_object('bootstrap', true, 'institution_slug', lower(btrim(p_institution_slug)))
  );

  return v_institution_id;
end;
$$;

revoke all on function public.provision_initial_institution_admin(uuid, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.provision_initial_institution_admin(uuid, text, text, text, text, text)
  to service_role;

notify pgrst, 'reload schema';

commit;
