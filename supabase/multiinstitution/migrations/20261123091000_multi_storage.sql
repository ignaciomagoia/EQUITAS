select public.assert_multiinstitution_platform();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'equitas-multi-imports',
  'equitas-multi-imports',
  false,
  104857600,
  array['text/csv', 'application/vnd.ms-excel']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create or replace function private.import_storage_institution_id(p_object_name text)
returns bigint
language plpgsql
immutable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_institution_text text;
begin
  if p_object_name !~ '^institution-[0-9]+/.+' then
    return null;
  end if;

  v_institution_text := substring(p_object_name from '^institution-([0-9]+)/');
  return v_institution_text::bigint;
end;
$$;

revoke all on function private.import_storage_institution_id(text) from public, anon;
grant execute on function private.import_storage_institution_id(text) to authenticated, service_role;

grant select, insert on storage.objects to authenticated;

create policy multi_import_object_select on storage.objects for select to authenticated
  using (
    bucket_id = 'equitas-multi-imports'
    and private.has_institution_permission(
      private.import_storage_institution_id(name),
      'institution.import.create'
    )
  );

create policy multi_import_object_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'equitas-multi-imports'
    and private.has_institution_permission(
      private.import_storage_institution_id(name),
      'institution.import.create'
    )
  );

notify pgrst, 'reload schema';
