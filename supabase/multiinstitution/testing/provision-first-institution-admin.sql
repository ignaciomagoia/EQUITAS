-- EJECUTAR SOLAMENTE EN EQUITAS-TP-TESTING (iylwghgvtydpmwidojdo).
-- Cree primero UN usuario ficticio en Authentication > Users, copie su UUID y
-- reemplacelo abajo. No agregue contrasenas ni claves a este archivo.
--
-- La RPC es exclusiva de service_role/SQL Editor y solo funciona si aun no hay
-- instituciones ni membresias. No crea ningun rol platform_admin.

select public.provision_initial_institution_admin(
  -- Reemplazar el UUID marcador antes de ejecutar. Nunca versionar UUIDs reales de Auth.
  '00000000-0000-0000-0000-000000000000'::uuid,
  'Administrador Universidad Demo',
  'universidad-demo',
  'Universidad Demo',
  'Universidad Demo Ficticia',
  'UNIVERSITY'
);
