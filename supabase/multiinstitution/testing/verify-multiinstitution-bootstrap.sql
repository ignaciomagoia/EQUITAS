-- Solo lectura. Verifica la provision inicial sin roles globales.

select
  installation.platform_key,
  installation.schema_version,
  installation.installed_at,
  (select count(*) from public.platform_user_role) as platform_admin_assignments,
  (select count(*) from public.institution where slug = 'universidad-demo') as universidad_demo_count
from public.platform_installation installation;

select
  has_function_privilege('authenticated', 'public.provision_initial_institution_admin(uuid,text,text,text,text,text)', 'EXECUTE') as authenticated_can_provision,
  has_function_privilege('anon', 'public.provision_initial_institution_admin(uuid,text,text,text,text,text)', 'EXECUTE') as anon_can_provision,
  has_function_privilege('service_role', 'public.provision_initial_institution_admin(uuid,text,text,text,text,text)', 'EXECUTE') as service_role_can_provision;

select
  event_type,
  subject_id,
  details,
  created_at
from public.administration_audit_event
where event_type = 'INITIAL_INSTITUTION_ADMIN_PROVISIONED'
order by created_at desc;
