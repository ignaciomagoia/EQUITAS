select public.assert_multiinstitution_platform();

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.platform_user_role assignment
    join public.platform_role role on role.id = assignment.role_id
    join public.app_user app_user on app_user.id = assignment.user_id
    where assignment.user_id = auth.uid()
      and role.code = 'platform_admin'
      and role.active
      and app_user.status = 'ACTIVE'
  );
$$;

create or replace function private.has_institution_permission(
  p_institution_id bigint,
  p_permission_code text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select private.is_platform_admin()
    or exists (
      select 1
      from public.institution_membership membership
      join public.app_user app_user on app_user.id = membership.user_id
      join public.institution_membership_role assigned_role
        on assigned_role.membership_id = membership.id
       and assigned_role.institution_id = membership.institution_id
      join public.institution_role_permission role_permission
        on role_permission.role_id = assigned_role.role_id
      where membership.institution_id = p_institution_id
        and membership.user_id = auth.uid()
        and membership.status = 'ACTIVE'
        and app_user.status = 'ACTIVE'
        and role_permission.permission_code = p_permission_code
        and exists (
          select 1
          from public.user_active_institution selection
          where selection.user_id = membership.user_id
            and selection.institution_id = membership.institution_id
        )
    );
$$;

create or replace function private.has_active_membership(p_institution_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select private.is_platform_admin()
    or exists (
      select 1
      from public.institution_membership membership
      join public.app_user app_user on app_user.id = membership.user_id
      where membership.institution_id = p_institution_id
        and membership.user_id = auth.uid()
        and membership.status = 'ACTIVE'
        and app_user.status = 'ACTIVE'
    );
$$;

create or replace function private.has_any_active_membership()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select private.is_platform_admin()
    or exists (
      select 1
      from public.institution_membership membership
      join public.app_user app_user on app_user.id = membership.user_id
      where membership.user_id = auth.uid()
        and membership.status = 'ACTIVE'
        and app_user.status = 'ACTIVE'
    );
$$;

create or replace function private.active_institution_id()
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select selection.institution_id
  from public.user_active_institution selection
  join public.institution_membership membership
    on membership.institution_id = selection.institution_id
   and membership.user_id = selection.user_id
  join public.app_user app_user on app_user.id = membership.user_id
  where selection.user_id = auth.uid()
    and membership.status = 'ACTIVE'
    and app_user.status = 'ACTIVE';
$$;

revoke all on function private.is_platform_admin() from public, anon;
revoke all on function private.has_institution_permission(bigint, text) from public, anon;
revoke all on function private.has_active_membership(bigint) from public, anon;
revoke all on function private.has_any_active_membership() from public, anon;
revoke all on function private.active_institution_id() from public, anon;
grant usage on schema private to authenticated, service_role;
grant execute on function private.is_platform_admin() to authenticated, service_role;
grant execute on function private.has_institution_permission(bigint, text) to authenticated, service_role;
grant execute on function private.has_active_membership(bigint) to authenticated, service_role;
grant execute on function private.has_any_active_membership() to authenticated, service_role;
grant execute on function private.active_institution_id() to authenticated, service_role;

alter table public.institution enable row level security;
alter table public.app_user enable row level security;
alter table public.platform_role enable row level security;
alter table public.institution_role enable row level security;
alter table public.permission enable row level security;
alter table public.platform_role_permission enable row level security;
alter table public.institution_role_permission enable row level security;
alter table public.platform_user_role enable row level security;
alter table public.institution_membership enable row level security;
alter table public.institution_membership_role enable row level security;
alter table public.user_active_institution enable row level security;
alter table public.currency enable row level security;
alter table public.document_type enable row level security;
alter table public.person_type enable row level security;
alter table public.contact_type enable row level security;
alter table public.province enable row level security;
alter table public.city enable row level security;
alter table public.institution_object_type enable row level security;
alter table public.institution_debt_status enable row level security;
alter table public.institution_data_source enable row level security;
alter table public.import_identity_scheme enable row level security;
alter table public.import_profile enable row level security;
alter table public.import_profile_version enable row level security;
alter table public.import_field_mapping enable row level security;
alter table public.debtor enable row level security;
alter table public.person enable row level security;
alter table public.debt enable row level security;
alter table public.debtor_person enable row level security;
alter table public.debtor_contact enable row level security;
alter table public.address enable row level security;
alter table public.debtor_profile enable row level security;
alter table public.debtor_profile_detail enable row level security;
alter table public.collection_action enable row level security;

grant select on public.institution, public.app_user, public.platform_role, public.institution_role,
  public.permission, public.platform_role_permission, public.institution_role_permission,
  public.platform_user_role, public.institution_membership, public.institution_membership_role,
  public.user_active_institution,
  public.currency, public.document_type, public.person_type, public.contact_type, public.province,
  public.city, public.institution_object_type, public.institution_debt_status,
  public.institution_data_source, public.import_identity_scheme, public.import_profile,
  public.import_profile_version, public.import_field_mapping, public.debtor, public.person,
  public.debt, public.debtor_person, public.debtor_contact, public.address,
  public.debtor_profile, public.debtor_profile_detail, public.collection_action to authenticated;

create policy institution_select on public.institution for select to authenticated
  using (private.has_active_membership(id));
create policy app_user_select on public.app_user for select to authenticated
  using (id = auth.uid() or private.is_platform_admin());
create policy membership_select on public.institution_membership for select to authenticated
  using (user_id = auth.uid() or private.has_institution_permission(institution_id, 'institution.members.read'));
create policy membership_role_select on public.institution_membership_role for select to authenticated
  using (
    private.has_institution_permission(institution_id, 'institution.members.read')
    or exists (
      select 1 from public.institution_membership membership
      where membership.id = membership_id and membership.user_id = auth.uid()
    )
  );
create policy user_active_institution_select on public.user_active_institution for select to authenticated
  using (user_id = auth.uid() or private.is_platform_admin());
create policy platform_role_select on public.platform_role for select to authenticated using (private.is_platform_admin());
create policy institution_role_select on public.institution_role for select to authenticated
  using (private.has_any_active_membership());
create policy permission_select on public.permission for select to authenticated
  using (private.has_any_active_membership());
create policy platform_user_role_select on public.platform_user_role for select to authenticated
  using (user_id = auth.uid() or private.is_platform_admin());
create policy platform_role_permission_select on public.platform_role_permission for select to authenticated
  using (private.is_platform_admin());
create policy institution_role_permission_select on public.institution_role_permission for select to authenticated
  using (private.has_any_active_membership());
create policy currency_select on public.currency for select to authenticated
  using (private.has_any_active_membership());
create policy document_type_select on public.document_type for select to authenticated
  using (private.has_any_active_membership());
create policy person_type_select on public.person_type for select to authenticated
  using (private.has_any_active_membership());
create policy contact_type_select on public.contact_type for select to authenticated
  using (private.has_any_active_membership());
create policy province_select on public.province for select to authenticated
  using (private.has_any_active_membership());
create policy city_select on public.city for select to authenticated
  using (private.has_any_active_membership());

create policy institution_object_type_select on public.institution_object_type for select to authenticated
  using (private.has_active_membership(institution_id));
create policy institution_debt_status_select on public.institution_debt_status for select to authenticated
  using (private.has_active_membership(institution_id));
create policy institution_data_source_select on public.institution_data_source for select to authenticated
  using (private.has_active_membership(institution_id));
create policy import_identity_scheme_select on public.import_identity_scheme for select to authenticated
  using (private.has_institution_permission(institution_id, 'institution.import.create'));
create policy import_profile_select on public.import_profile for select to authenticated
  using (private.has_institution_permission(institution_id, 'institution.import.create'));
create policy import_profile_version_select on public.import_profile_version for select to authenticated
  using (private.has_institution_permission(institution_id, 'institution.import.create'));
create policy import_field_mapping_select on public.import_field_mapping for select to authenticated
  using (exists (
    select 1 from public.import_profile_version version
    where version.id = profile_version_id
      and private.has_institution_permission(version.institution_id, 'institution.import.create')
  ));

create policy debtor_select on public.debtor for select to authenticated
  using (private.has_institution_permission(institution_id, 'institution.debt.read'));
create policy person_select on public.person for select to authenticated
  using (private.has_institution_permission(institution_id, 'institution.debt.read'));
create policy debt_select on public.debt for select to authenticated
  using (private.has_institution_permission(institution_id, 'institution.debt.read'));
create policy debtor_person_select on public.debtor_person for select to authenticated
  using (private.has_institution_permission(institution_id, 'institution.debt.read'));
create policy debtor_contact_select on public.debtor_contact for select to authenticated
  using (private.has_institution_permission(institution_id, 'institution.debt.read'));
create policy address_select on public.address for select to authenticated
  using (private.has_institution_permission(institution_id, 'institution.debt.read'));
create policy debtor_profile_select on public.debtor_profile for select to authenticated
  using (private.has_institution_permission(institution_id, 'institution.dashboard.read'));
create policy debtor_profile_detail_select on public.debtor_profile_detail for select to authenticated
  using (private.has_institution_permission(institution_id, 'institution.dashboard.read'));
create policy collection_action_select on public.collection_action for select to authenticated
  using (private.has_institution_permission(institution_id, 'institution.actions.manage'));

notify pgrst, 'reload schema';
