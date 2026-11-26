-- Solo lectura. Reemplace el UUID por el usado en provision-first-institution-admin.sql.
-- Muestra separadamente cada condicion exigida por seed-multiinstitution-fixtures.sql.

with parameters as (
  -- Reemplazar el UUID marcador antes de ejecutar. Nunca versionar UUIDs reales de Auth.
  select '00000000-0000-0000-0000-000000000000'::uuid as user_id
), university as (
  select id
  from public.institution
  where slug = 'universidad-demo'
), institution_admin_role as (
  select id
  from public.institution_role
  where code = 'institution_admin' and active
), membership as (
  select membership.*
  from public.institution_membership membership
  join parameters on parameters.user_id = membership.user_id
  join university on university.id = membership.institution_id
)
select
  parameters.user_id,
  exists (select 1 from auth.users auth_user where auth_user.id = parameters.user_id) as auth_user_exists,
  exists (select 1 from public.app_user app_user where app_user.id = parameters.user_id and app_user.status = 'ACTIVE') as app_user_active,
  (select id from university) as university_id,
  (select id from membership where status = 'ACTIVE') as active_membership_id,
  exists (
    select 1
    from public.institution_membership_role membership_role
    join membership on membership.id = membership_role.membership_id
    join institution_admin_role on institution_admin_role.id = membership_role.role_id
    where membership_role.institution_id = (select id from university)
  ) as has_institution_admin_role,
  exists (
    select 1
    from public.user_active_institution selection
    join university on university.id = selection.institution_id
    where selection.user_id = parameters.user_id
  ) as university_is_selected,
  exists (
    select 1 from public.import_control control
    join university on university.id = control.institution_id
    where control.apply_enabled = false
  ) as apply_is_disabled,
  exists (
    select 1
    from public.import_authorization authorization_record
    join membership on membership.id = authorization_record.membership_id
    join university on university.id = authorization_record.institution_id
    where membership.status = 'ACTIVE'
      and authorization_record.active
      and authorization_record.can_import
      and not authorization_record.can_apply
  ) as import_is_dry_run_only,
  exists (
    select 1 from public.platform_user_role platform_role
    where platform_role.user_id = parameters.user_id
  ) as has_platform_role
from parameters;
