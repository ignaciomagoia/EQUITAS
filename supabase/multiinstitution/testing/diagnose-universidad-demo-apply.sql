-- Diagnóstico de solo lectura para los tres controles de APPLY.
-- Debe devolver una única fila para Universidad Demo.
select
  institution.slug,
  institution.status as institution_status,
  membership.status as membership_status,
  ia.active as authorization_active,
  ia.can_import,
  ia.can_apply,
  control.apply_enabled
from public.institution institution
join public.institution_membership membership
  on membership.institution_id = institution.id
join public.import_authorization ia
  on ia.institution_id = institution.id
 and ia.membership_id = membership.id
join public.import_control control
  on control.institution_id = institution.id
where institution.slug = 'universidad-demo'
  -- Reemplazar el UUID marcador antes de ejecutar. Nunca versionar UUIDs reales de Auth.
  and membership.user_id = '00000000-0000-0000-0000-000000000000'::uuid;
