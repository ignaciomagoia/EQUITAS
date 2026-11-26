-- Habilitacion manual, temporal y deliberada para probar APPLY en la base
-- Multiinstitucion. Ejecutar solamente despues de instalar la migracion 091600.
-- No contiene credenciales ni afecta a La Falda.
begin;

select public.assert_multiinstitution_platform();

do $$
declare
  v_institution_id bigint;
  v_membership_id bigint;
  -- Reemplazar el UUID marcador antes de ejecutar. Nunca versionar UUIDs reales de Auth.
  v_user_id uuid := '00000000-0000-0000-0000-000000000000';
begin
  select id into v_institution_id
  from public.institution
  where slug = 'universidad-demo' and status = 'ACTIVE';
  if v_institution_id is null then raise exception 'No existe la institucion Universidad Demo activa.'; end if;

  select id into v_membership_id from public.institution_membership
  where institution_id = v_institution_id and user_id = v_user_id and status = 'ACTIVE';
  if v_membership_id is null then raise exception 'El usuario de prueba no tiene membresia activa en Universidad Demo.'; end if;

  update public.import_authorization
  set can_import = true, can_apply = true, active = true, revoked_at = null, updated_at = now()
  where institution_id = v_institution_id and membership_id = v_membership_id;
  if not found then raise exception 'No existe autorizacion de importacion para el administrador institucional.'; end if;

  update public.import_control set apply_enabled = true, updated_at = now() where institution_id = v_institution_id;
  if not found then raise exception 'No existe control de importacion para Universidad Demo.'; end if;
end;
$$;

commit;

-- Verificacion posterior, solo lectura.
select institution.slug, ia.can_import, ia.can_apply, ia.active, control.apply_enabled
from public.institution institution
join public.institution_membership membership on membership.institution_id = institution.id
join public.import_authorization ia on ia.institution_id = institution.id and ia.membership_id = membership.id
join public.import_control control on control.institution_id = institution.id
where institution.slug = 'universidad-demo'
  -- Reemplazar el UUID marcador antes de ejecutar. Nunca versionar UUIDs reales de Auth.
  and membership.user_id = '00000000-0000-0000-0000-000000000000'::uuid;
