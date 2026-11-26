-- Solo lectura. Confirma que Universidad Demo y sus datos ficticios existen.

select
  institution.slug,
  institution.name,
  institution.institution_type,
  (select count(*) from public.institution_membership membership where membership.institution_id = institution.id and membership.status = 'ACTIVE') as active_memberships,
  (select count(*) from public.debtor debtor where debtor.institution_id = institution.id) as debtors,
  (select count(*) from public.person person where person.institution_id = institution.id) as people,
  (select count(*) from public.debt debt where debt.institution_id = institution.id) as debts,
  (select count(*) from public.debtor_profile profile where profile.institution_id = institution.id) as profiles,
  (select count(*) from public.import_control control where control.institution_id = institution.id and control.apply_enabled = false) as apply_disabled_controls
from public.institution institution
where institution.slug = 'universidad-demo';

select
  app_user.full_name,
  institution_role.code as institutional_role,
  import_authorization.can_import,
  import_authorization.can_apply,
  import_authorization.active,
  active_selection.institution_id = membership.institution_id as university_is_selected,
  not exists (
    select 1 from public.platform_user_role platform_role
    where platform_role.user_id = membership.user_id
  ) as has_no_platform_role
from public.institution_membership membership
join public.institution institution on institution.id = membership.institution_id
join public.app_user app_user on app_user.id = membership.user_id
join public.institution_membership_role membership_role
  on membership_role.membership_id = membership.id
 and membership_role.institution_id = membership.institution_id
join public.institution_role institution_role on institution_role.id = membership_role.role_id
left join public.import_authorization
  on import_authorization.institution_id = membership.institution_id
 and import_authorization.membership_id = membership.id
left join public.user_active_institution active_selection on active_selection.user_id = membership.user_id
where institution.slug = 'universidad-demo';

select
  'debt_to_debtor_institution_mismatch' as check_name,
  count(*) as invalid_rows
from public.debt debt
join public.debtor debtor on debtor.id = debt.debtor_id
where debt.institution_id <> debtor.institution_id
union all
select
  'relationship_institution_mismatch',
  count(*)
from public.debtor_person relationship
join public.debtor debtor on debtor.id = relationship.debtor_id
join public.person person on person.id = relationship.person_id
where relationship.institution_id <> debtor.institution_id
   or relationship.institution_id <> person.institution_id
union all
select
  'profile_institution_mismatch',
  count(*)
from public.debtor_profile profile
join public.debtor debtor on debtor.id = profile.debtor_id
where profile.institution_id <> debtor.institution_id;
