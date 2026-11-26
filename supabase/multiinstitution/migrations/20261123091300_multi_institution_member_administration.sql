begin;

select public.assert_multiinstitution_platform();

insert into public.permission (code, scope, description)
values ('institution.members.manage', 'INSTITUTION', 'Incorporar usuarios existentes y asignar roles institucionales.')
on conflict (code) do nothing;

insert into public.institution_role_permission (role_id, permission_code)
select role.id, permission.code
from public.institution_role role
join public.permission permission on permission.code = 'institution.members.manage'
where role.code = 'institution_admin'
on conflict do nothing;

create or replace function public.manage_institution_member(
  p_institution_id bigint,
  p_user_id uuid,
  p_full_name text,
  p_role_code text
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text;
  v_membership_id bigint;
  v_role_id bigint;
begin
  if not private.has_institution_permission(p_institution_id, 'institution.members.manage') then
    raise exception 'No tiene permiso para administrar usuarios de esta institucion.';
  end if;

  if nullif(btrim(p_full_name), '') is null then
    raise exception 'El nombre completo es obligatorio.';
  end if;

  select email into v_email
  from auth.users
  where id = p_user_id;
  if v_email is null then
    raise exception 'El usuario de Supabase Auth indicado no existe.';
  end if;

  select id into v_role_id
  from public.institution_role
  where code = p_role_code
    and active;
  if v_role_id is null then
    raise exception 'El rol institucional indicado no existe o no esta activo.';
  end if;

  insert into public.app_user (id, full_name, email, status)
  values (p_user_id, btrim(p_full_name), v_email, 'ACTIVE')
  on conflict (id) do update
    set full_name = excluded.full_name,
        email = excluded.email,
        status = 'ACTIVE',
        updated_at = now();

  insert into public.institution_membership (institution_id, user_id, status, granted_by, revoked_at)
  values (p_institution_id, p_user_id, 'ACTIVE', auth.uid(), null)
  on conflict (institution_id, user_id) do update
    set status = 'ACTIVE',
        granted_by = excluded.granted_by,
        revoked_at = null,
        updated_at = now()
  returning id into v_membership_id;

  insert into public.institution_membership_role (membership_id, institution_id, role_id, granted_by)
  values (v_membership_id, p_institution_id, v_role_id, auth.uid())
  on conflict do nothing;

  insert into public.administration_audit_event (
    actor_user_id, institution_id, event_type, subject_type, subject_id, details
  ) values (
    auth.uid(), p_institution_id, 'INSTITUTION_MEMBER_MANAGED', 'APP_USER', p_user_id::text,
    jsonb_build_object('role_code', p_role_code)
  );

  return v_membership_id;
end;
$$;

-- Devuelve automaticamente la unica institucion activa. Si existen varias,
-- devuelve NULL para que la interfaz solicite una seleccion explicita.
create or replace function public.ensure_active_institution()
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_selected_institution_id bigint;
  v_membership_count integer;
  v_only_institution_id bigint;
begin
  select selection.institution_id into v_selected_institution_id
  from public.user_active_institution selection
  join public.institution_membership membership
    on membership.institution_id = selection.institution_id
   and membership.user_id = selection.user_id
  join public.app_user app_user on app_user.id = membership.user_id
  where selection.user_id = auth.uid()
    and membership.status = 'ACTIVE'
    and app_user.status = 'ACTIVE';

  if v_selected_institution_id is not null then
    return v_selected_institution_id;
  end if;

  select count(*), min(institution_id)
  into v_membership_count, v_only_institution_id
  from public.institution_membership membership
  join public.app_user app_user on app_user.id = membership.user_id
  where membership.user_id = auth.uid()
    and membership.status = 'ACTIVE'
    and app_user.status = 'ACTIVE';

  if v_membership_count = 1 then
    insert into public.user_active_institution (user_id, institution_id, selected_at)
    values (auth.uid(), v_only_institution_id, now())
    on conflict (user_id) do update
      set institution_id = excluded.institution_id,
          selected_at = excluded.selected_at;
    return v_only_institution_id;
  end if;

  return null;
end;
$$;

drop policy if exists app_user_select on public.app_user;
create policy app_user_select on public.app_user for select to authenticated
  using (
    id = auth.uid()
    or private.is_platform_admin()
    or exists (
      select 1
      from public.institution_membership target_membership
      where target_membership.user_id = public.app_user.id
        and private.has_institution_permission(target_membership.institution_id, 'institution.members.read')
    )
  );

revoke all on function public.manage_institution_member(bigint, uuid, text, text) from public, anon;
revoke all on function public.ensure_active_institution() from public, anon;
grant execute on function public.manage_institution_member(bigint, uuid, text, text) to authenticated;
grant execute on function public.ensure_active_institution() to authenticated;

notify pgrst, 'reload schema';

commit;
