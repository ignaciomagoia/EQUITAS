-- RESERVADO PARA UNA FUTURA CUENTA ADMINISTRATIVA GLOBAL DE EQUITAS.
-- NO EJECUTAR PARA EL USUARIO DE UNIVERSIDAD DEMO.
--
-- Ejecutar solamente en EQUITAS-TP-TESTING (iylwghgvtydpmwidojdo) cuando se
-- necesite crear el primer platform_admin real de la plataforma.
-- Antes, cree manualmente el usuario inicial en Authentication > Users y
-- reemplace el UUID. No incluya ni pegue contrasenas en este archivo.
--
-- Este comando solo funciona una vez: despues se bloquea al existir el primer
-- rol de plataforma. Los usuarios autenticados no tienen EXECUTE sobre la RPC.

select public.bootstrap_first_platform_admin(
  'REEMPLAZAR-CON-UUID-DEL-PRIMER-ADMIN'::uuid,
  'Administrador inicial EQUITAS'
);
