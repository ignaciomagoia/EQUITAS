begin;

select public.assert_multiinstitution_platform();

-- La versión original evaluaba columnas de import_identity_scheme aun cuando
-- el trigger se ejecutaba sobre import_field_mapping. PostgreSQL no garantiza
-- el cortocircuito necesario para acceder a NEW.entity_kind en esa tabla.
-- Cada tabla se trata en un bloque propio para conservar la inmutabilidad del
-- historial sin acceder a columnas que no existen.
create or replace function public.protect_import_configuration_history()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile_status text;
  v_profile_version_id bigint;
begin
  if tg_table_name = 'import_identity_scheme' then
    if tg_op = 'UPDATE' and
       (new.entity_kind, new.canonical_fields, new.normalizer_version) is distinct from
       (old.entity_kind, old.canonical_fields, old.normalizer_version) then
      raise exception 'Un esquema de identidad es inmutable. Cree uno nuevo y retire el anterior.';
    end if;
  end if;

  if tg_table_name = 'import_profile_version' then
    if tg_op = 'UPDATE' and old.status <> 'DRAFT' and
       (new.institution_id, new.profile_id, new.version_number, new.delimiter, new.encoding,
        new.debtor_identity_scheme_id, new.debt_identity_scheme_id, new.person_identity_scheme_id)
       is distinct from
       (old.institution_id, old.profile_id, old.version_number, old.delimiter, old.encoding,
        old.debtor_identity_scheme_id, old.debt_identity_scheme_id, old.person_identity_scheme_id) then
      raise exception 'Una version no borrador es inmutable. Cree una nueva version del perfil.';
    end if;
  end if;

  if tg_table_name = 'import_field_mapping' then
    v_profile_version_id := case
      when tg_op = 'DELETE' then old.profile_version_id
      else new.profile_version_id
    end;

    select status into v_profile_status
    from public.import_profile_version
    where id = v_profile_version_id;

    if v_profile_status <> 'DRAFT' then
      raise exception 'Los mapeos solo se pueden modificar mientras la version esta en borrador.';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

revoke all on function public.protect_import_configuration_history() from public, anon, authenticated;
grant execute on function public.protect_import_configuration_history() to service_role;

notify pgrst, 'reload schema';

commit;
