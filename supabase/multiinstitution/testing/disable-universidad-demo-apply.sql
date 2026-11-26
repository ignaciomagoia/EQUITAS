-- Vuelve a bloquear APPLY al finalizar una prueba supervisada.
begin;
select public.assert_multiinstitution_platform();
update public.import_control
set apply_enabled = false, updated_at = now()
where institution_id = (select id from public.institution where slug = 'universidad-demo');
update public.import_authorization ia
set can_apply = false, updated_at = now()
from public.institution_membership membership
where ia.membership_id = membership.id
  -- Reemplazar el UUID marcador antes de ejecutar. Nunca versionar UUIDs reales de Auth.
  and membership.user_id = '00000000-0000-0000-0000-000000000000'::uuid
  and ia.institution_id = (select id from public.institution where slug = 'universidad-demo');
commit;
