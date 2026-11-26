-- Prueba transaccional de RLS. Crea una segunda institucion y una deuda solo
-- dentro de esta transaccion; siempre termina con ROLLBACK y no crea usuarios
-- Auth ni datos permanentes adicionales.

begin;

do $$
declare
  v_university_admin_id uuid;
  v_university_id bigint;
  v_other_institution_id bigint;
  v_other_object_type_id bigint;
  v_other_status_id bigint;
  v_other_debtor_scheme_id bigint;
  v_other_debt_scheme_id bigint;
  v_other_debtor_id bigint;
  v_currency_id bigint;
begin
  select membership.user_id, membership.institution_id
  into v_university_admin_id, v_university_id
  from public.institution_membership membership
  join public.institution institution on institution.id = membership.institution_id
  join public.institution_membership_role membership_role
    on membership_role.membership_id = membership.id
   and membership_role.institution_id = membership.institution_id
  join public.institution_role institution_role on institution_role.id = membership_role.role_id
  where institution.slug = 'universidad-demo'
    and membership.status = 'ACTIVE'
    and institution_role.code = 'institution_admin'
  limit 1;

  if v_university_admin_id is null or v_university_id is null then
    raise exception 'No existe el administrador institucional de Universidad Demo.';
  end if;

  if exists (select 1 from public.platform_user_role where user_id = v_university_admin_id) then
    raise exception 'El usuario de Universidad Demo no debe tener roles de plataforma.';
  end if;

  select id into v_currency_id from public.currency where code = 'ARS' and active;
  if v_currency_id is null then
    raise exception 'No existe la moneda ARS activa.';
  end if;

  insert into public.institution (slug, name, institution_type)
  values ('rls-temporal-aislamiento', 'Institucion temporal RLS', 'UNIVERSITY')
  returning id into v_other_institution_id;

  insert into public.institution_object_type (institution_id, code, name)
  values (v_other_institution_id, 'TEMP', 'Objeto temporal')
  returning id into v_other_object_type_id;
  insert into public.institution_debt_status (institution_id, code, name)
  values (v_other_institution_id, 'OPEN', 'Abierta')
  returning id into v_other_status_id;
  insert into public.import_identity_scheme (institution_id, entity_kind, code, display_name, canonical_fields)
  values
    (v_other_institution_id, 'DEBTOR', 'TEMP_OBJECT', 'Objeto temporal', array['object_code']),
    (v_other_institution_id, 'DEBT', 'TEMP_DEBT', 'Deuda temporal', array['debt_code']);

  select id into v_other_debtor_scheme_id
  from public.import_identity_scheme
  where institution_id = v_other_institution_id and code = 'TEMP_OBJECT';
  select id into v_other_debt_scheme_id
  from public.import_identity_scheme
  where institution_id = v_other_institution_id and code = 'TEMP_DEBT';

  insert into public.debtor (
    institution_id, object_type_id, identity_scheme_id, identity_hash, identity_values, identifier
  ) values (
    v_other_institution_id, v_other_object_type_id, v_other_debtor_scheme_id,
    repeat('d', 64), jsonb_build_object('object_code', 'RLS-TEMP-001'), 'RLS-TEMP-001'
  ) returning id into v_other_debtor_id;

  insert into public.debt (
    institution_id, debtor_id, identity_scheme_id, identity_hash, identity_values,
    description, original_amount, current_amount, currency_id, status_id
  ) values (
    v_other_institution_id, v_other_debtor_id, v_other_debt_scheme_id,
    repeat('e', 64), jsonb_build_object('debt_code', 'RLS-TEMP-DEBT-001'),
    'Deuda temporal de prueba RLS', 1, 1, v_currency_id, v_other_status_id
  );

  perform set_config('equitas.demo.university_admin_id', v_university_admin_id::text, true);
  perform set_config('equitas.demo.university_id', v_university_id::text, true);
  perform set_config('equitas.demo.other_institution_id', v_other_institution_id::text, true);
end;
$$;

select
  tablename,
  rowsecurity as rls_enabled
from pg_tables
where schemaname = 'public'
  and tablename in ('institution', 'institution_membership', 'debtor', 'person', 'debt', 'debtor_profile')
order by tablename;

set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('equitas.demo.university_admin_id'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select
  'university_institution_admin' as scenario,
  private.is_platform_admin() as is_platform_admin,
  private.has_institution_permission(current_setting('equitas.demo.university_id')::bigint, 'institution.debt.read') as can_read_university,
  private.has_institution_permission(current_setting('equitas.demo.other_institution_id')::bigint, 'institution.debt.read') as can_read_other_institution,
  (select count(*) from public.debt where institution_id = current_setting('equitas.demo.university_id')::bigint) as university_debts_visible,
  (select count(*) from public.debt where institution_id = current_setting('equitas.demo.other_institution_id')::bigint) as other_institution_debts_visible,
  has_function_privilege('authenticated', 'public.provision_initial_institution_admin(uuid,text,text,text,text,text)', 'EXECUTE') as can_call_initial_provision;

do $$
begin
  begin
    perform public.create_institution(
      'blocked-by-institution-admin', 'Bloqueada', null, 'UNIVERSITY', auth.uid()
    );
    raise exception 'La creacion global no fue bloqueada.';
  exception
    when others then
      if position('Solo un administrador de EQUITAS puede crear instituciones.' in sqlerrm) = 0 then
        raise;
      end if;
  end;

  begin
    perform public.manage_institution_member(
      current_setting('equitas.demo.other_institution_id')::bigint,
      auth.uid(),
      'Intento fuera de institucion',
      'viewer'
    );
    raise exception 'La administracion de otra institucion no fue bloqueada.';
  exception
    when others then
      if position('No tiene permiso para administrar usuarios de esta institucion.' in sqlerrm) = 0 then
        raise;
      end if;
  end;
end;
$$;

rollback;
