-- Solo lectura. Ejecutar antes de provision-first-institution-admin.sql.
-- Debe devolver EQUITAS_MULTIINSTITUTION y ceros en los conteos operativos.

select
  installation.platform_key,
  installation.schema_version,
  (select count(*) from public.institution) as institutions,
  (select count(*) from public.institution_membership) as memberships,
  (select count(*) from public.platform_user_role) as platform_role_assignments,
  (select count(*) from public.app_user) as application_users
from public.platform_installation installation;
