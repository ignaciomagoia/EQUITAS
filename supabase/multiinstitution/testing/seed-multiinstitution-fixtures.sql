-- DATOS FICTICIOS EXCLUSIVOS DE EQUITAS-TP-TESTING.
-- Reemplace el UUID por el mismo usuario usado en provision-first-institution-admin.sql.
-- Este script no crea instituciones, membresias ni roles: exige que la provision
-- inicial segura ya haya vinculado al usuario como institution_admin.

begin;

do $$
declare
  -- Reemplazar el UUID marcador antes de ejecutar. Nunca versionar UUIDs reales de Auth.
  v_admin_user_id uuid := '00000000-0000-0000-0000-000000000000';
  v_university_id bigint;
  v_admin_membership_id bigint;
  v_institution_admin_role_id bigint;
  v_currency_id bigint;
  v_document_type_id bigint;
  v_person_type_id bigint;
  v_email_contact_type_id bigint;
  v_object_type_id bigint;
  v_status_id bigint;
  v_debtor_scheme_id bigint;
  v_debt_scheme_id bigint;
  v_person_scheme_id bigint;
  v_debtor_id bigint;
  v_person_id bigint;
  v_profile_id bigint;
  v_has_membership_role boolean;
  v_has_active_selection boolean;
  v_has_disabled_control boolean;
  v_has_dry_run_import_authorization boolean;
begin
  perform public.assert_multiinstitution_platform();

  select id into v_university_id
  from public.institution
  where slug = 'universidad-demo';
  if v_university_id is null then
    raise exception 'Ejecute primero provision_initial_institution_admin para Universidad Demo.';
  end if;

  select id into v_admin_membership_id
  from public.institution_membership
  where institution_id = v_university_id and user_id = v_admin_user_id and status = 'ACTIVE';
  select id into v_institution_admin_role_id
  from public.institution_role
  where code = 'institution_admin' and active;

  select exists (
    select 1 from public.institution_membership_role membership_role
    where membership_role.membership_id = v_admin_membership_id
      and membership_role.institution_id = v_university_id
      and membership_role.role_id = v_institution_admin_role_id
  ) into v_has_membership_role;
  select exists (
    select 1 from public.user_active_institution selection
    where selection.user_id = v_admin_user_id
      and selection.institution_id = v_university_id
  ) into v_has_active_selection;
  select exists (
    select 1 from public.import_control control
    where control.institution_id = v_university_id
      and control.apply_enabled = false
  ) into v_has_disabled_control;
  select exists (
    select 1 from public.import_authorization authorization_record
    where authorization_record.institution_id = v_university_id
      and authorization_record.membership_id = v_admin_membership_id
      and authorization_record.active
      and authorization_record.can_import
      and not authorization_record.can_apply
  ) into v_has_dry_run_import_authorization;

  if v_admin_membership_id is null
     or not coalesce(v_has_membership_role, false)
     or not coalesce(v_has_active_selection, false)
     or not coalesce(v_has_disabled_control, false)
     or not coalesce(v_has_dry_run_import_authorization, false) then
    raise exception 'La provision inicial de Universidad Demo no tiene los permisos esperados.'
      using detail = jsonb_build_object(
        'active_membership', v_admin_membership_id is not null,
        'institution_admin_role', coalesce(v_has_membership_role, false),
        'active_institution_selection', coalesce(v_has_active_selection, false),
        'apply_disabled', coalesce(v_has_disabled_control, false),
        'dry_run_import_authorization', coalesce(v_has_dry_run_import_authorization, false)
      )::text;
  end if;

  select id into v_currency_id from public.currency where code = 'ARS' and active;
  select id into v_document_type_id from public.document_type where code = 'DNI' and active;
  select id into v_person_type_id from public.person_type where code = 'INDIVIDUAL' and active;
  select id into v_email_contact_type_id from public.contact_type where code = 'EMAIL' and active;
  if v_currency_id is null or v_document_type_id is null or v_person_type_id is null or v_email_contact_type_id is null then
    raise exception 'Faltan catalogos base de las migraciones multiinstitucion.';
  end if;

  insert into public.institution_object_type (institution_id, code, name)
  values (v_university_id, 'ARANCEL', 'Arancel universitario ficticio')
  on conflict (institution_id, code) do nothing;
  insert into public.institution_debt_status (institution_id, code, name)
  values (v_university_id, 'OVERDUE', 'Vencida')
  on conflict (institution_id, code) do nothing;
  insert into public.institution_data_source (institution_id, name, source_kind)
  values (v_university_id, 'CSV de demostracion', 'CSV')
  on conflict (institution_id, name) do nothing;

  insert into public.import_identity_scheme (institution_id, entity_kind, code, display_name, canonical_fields)
  values
    (v_university_id, 'DEBTOR', 'UNIV_ACCOUNT', 'Cuenta universitaria', array['account_code']),
    (v_university_id, 'DEBT', 'UNIV_INSTALLMENT', 'Cuota universitaria', array['installment_code']),
    (v_university_id, 'PERSON', 'UNIV_PERSON', 'Persona universitaria', array['document_number'])
  on conflict (institution_id, entity_kind, code) do nothing;

  select id into v_object_type_id from public.institution_object_type
    where institution_id = v_university_id and code = 'ARANCEL';
  select id into v_status_id from public.institution_debt_status
    where institution_id = v_university_id and code = 'OVERDUE';
  select id into v_debtor_scheme_id from public.import_identity_scheme
    where institution_id = v_university_id and entity_kind = 'DEBTOR' and code = 'UNIV_ACCOUNT';
  select id into v_debt_scheme_id from public.import_identity_scheme
    where institution_id = v_university_id and entity_kind = 'DEBT' and code = 'UNIV_INSTALLMENT';
  select id into v_person_scheme_id from public.import_identity_scheme
    where institution_id = v_university_id and entity_kind = 'PERSON' and code = 'UNIV_PERSON';

  insert into public.debtor (
    institution_id, object_type_id, identity_scheme_id, identity_hash, identity_values,
    external_reference, identifier, description
  ) values (
    v_university_id, v_object_type_id, v_debtor_scheme_id, repeat('a', 64),
    jsonb_build_object('account_code', 'UNIV-CTA-001'), 'UNIV-CTA-001', 'UNIV-CTA-001', 'Cuenta universitaria ficticia'
  ) on conflict (institution_id, identity_scheme_id, identity_hash) do update
    set description = excluded.description, active = true, updated_at = now();

  insert into public.person (
    institution_id, identity_scheme_id, identity_hash, identity_values, external_reference,
    document_type_id, document_number, full_name, person_type_id
  ) values (
    v_university_id, v_person_scheme_id, repeat('b', 64),
    jsonb_build_object('document_number', '90000002'), 'PERS-UNIV-001',
    v_document_type_id, '90000002', 'Persona universitaria ficticia', v_person_type_id
  ) on conflict (institution_id, identity_scheme_id, identity_hash) do update
    set full_name = excluded.full_name, active = true, updated_at = now();

  select id into v_debtor_id from public.debtor
    where institution_id = v_university_id and identity_hash = repeat('a', 64);
  select id into v_person_id from public.person
    where institution_id = v_university_id and identity_hash = repeat('b', 64);

  insert into public.debtor_person (institution_id, debtor_id, person_id, priority, relationship_role)
  values (v_university_id, v_debtor_id, v_person_id, 1, 'RESPONSABLE')
  on conflict (institution_id, debtor_id, person_id) do update
    set active = true, relationship_role = excluded.relationship_role, updated_at = now();

  insert into public.debtor_contact (institution_id, person_id, contact_type_id, value)
  values (v_university_id, v_person_id, v_email_contact_type_id, 'persona.universitaria@example.test')
  on conflict (institution_id, person_id, contact_type_id, value) do update
    set active = true, updated_at = now();

  insert into public.debt (
    institution_id, debtor_id, identity_scheme_id, identity_hash, identity_values,
    external_reference, type, description, original_amount, current_amount, updated_amount,
    currency_id, issue_date, due_date, period, status_id
  ) values (
    v_university_id, v_debtor_id, v_debt_scheme_id, repeat('c', 64),
    jsonb_build_object('installment_code', 'UNIV-CUOTA-001'), 'UNIV-CUOTA-001', 'ARANCEL',
    'Deuda universitaria ficticia', 2000.00, 2400.00, 2400.00, v_currency_id,
    date '2026-03-01', date '2026-04-01', '2026-03', v_status_id
  ) on conflict (institution_id, debtor_id, identity_scheme_id, identity_hash) do update
    set current_amount = excluded.current_amount,
        updated_amount = excluded.updated_amount,
        due_date = excluded.due_date,
        active = true,
        updated_at = now();

  insert into public.debtor_profile (
    institution_id, debtor_id, total_debt_amount, overdue_debt_amount, debt_count,
    overdue_debt_count, oldest_debt_days, average_debt_age_days, active_person_count,
    available_contact_count, socioeconomic_risk_level, profile_generated_at
  ) values (
    v_university_id, v_debtor_id, 2400.00, 2400.00, 1, 1, 45, 45, 1, 1, 72, now()
  ) on conflict (institution_id, debtor_id) do update
    set total_debt_amount = excluded.total_debt_amount,
        overdue_debt_amount = excluded.overdue_debt_amount,
        debt_count = excluded.debt_count,
        overdue_debt_count = excluded.overdue_debt_count,
        socioeconomic_risk_level = excluded.socioeconomic_risk_level,
        profile_generated_at = excluded.profile_generated_at;

  select id into v_profile_id from public.debtor_profile
    where institution_id = v_university_id and debtor_id = v_debtor_id;

  insert into public.debtor_profile_detail (institution_id, debtor_profile_id, person_id, risk_value, reason)
  values (v_university_id, v_profile_id, v_person_id, 71, 'Dato ficticio de demostracion')
  on conflict (institution_id, debtor_profile_id, person_id) do update
    set risk_value = excluded.risk_value, reason = excluded.reason, active = true;

  insert into public.administration_audit_event (institution_id, event_type, subject_type, subject_id, details)
  values (
    v_university_id, 'DEMO_FIXTURES_UPSERTED', 'INSTITUTION', v_university_id::text,
    jsonb_build_object('institution', 'universidad-demo', 'synthetic', true)
  );
end;
$$;

commit;
