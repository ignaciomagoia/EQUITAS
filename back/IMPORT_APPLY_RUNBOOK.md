# Habilitacion controlada de importaciones con escritura

Este procedimiento se aplica **antes** de habilitar cualquier trabajo en modo `apply`.
No sustituye las copias administradas de Supabase ni debe ejecutarse desde el navegador.

## Alcance y estado seguro

- Tenant municipal protegido: `1` (La Falda).
- Estado inicial obligatorio: `lafalda_import_control.apply_enabled = false`.
- La variable `LAFALDA_IMPORT_APPLY_ENABLED` debe permanecer en `false`.
- La migracion `20261122110000_lafalda_import_authorization_audit.sql` no concede permisos a nadie. Un usuario debe ser autorizado explicitamente por un administrador de base de datos.
- Un trabajo `apply` requiere simultaneamente: autorizacion activa del solicitante, permiso `can_apply`, bandera de frontend/worker y freno de base de datos `apply_enabled=true`.

## Entorno de escritura aislado obligatorio

No se debe usar un tenant ficticio dentro del proyecto de Supabase que contiene las 56.286 deudas municipales. La implementacion actual esta restringida intencionalmente a `tenant = 1` mediante `check (tenant = 1)` y las RPC rechazan cualquier otro tenant.

Para las primeras escrituras se debe crear un **proyecto Supabase de pruebas separado** (plan gratuito es suficiente), sin datos personales ni copia de produccion. Debe contener:

1. El esquema y las migraciones del repositorio, incluida la migracion de importaciones y la de autorizacion/auditoria.
2. Un tenant sintético con id `1`, usuarios sintéticos, un deudor sintético y deudas sintéticas.
3. Un bucket privado `lafalda-imports` creado por la migracion.
4. Credenciales exclusivas del proyecto de pruebas, configuradas solo como secretos del repositorio/entorno de pruebas.
5. `LAFALDA_IMPORT_APPLY_ENABLED=false` hasta completar los controles previos.

La prueba de integracion opt-in `back/tests/integration/test_local_apply_worker.py` cubre insercion, actualizacion, actualizacion parcial, conservacion de deuda ausente y freno de escritura. Por seguridad solo acepta `localhost`. Para el proyecto Supabase de pruebas se debe reproducir ese mismo escenario mediante un workflow dedicado y secretos de prueba; nunca con la URL o claves de produccion.

## Respaldo verificable y restaurable

Antes de una habilitacion real, el administrador de Supabase debe:

1. Confirmar que existe una copia administrada recuperable en el plan contratado o generar una exportacion consistente con una cuenta de administracion fuera de EQUITAS.
2. Registrar fecha, responsable, identificador de backup, version de migraciones y el hash SHA-256 del artefacto de exportacion en el registro operativo protegido de la municipalidad.
3. Validar la restauracion en un proyecto Supabase aislado: restaurar el backup, ejecutar una consulta de conteo de `debt` para tenant `1` y comprobar las restricciones `debt(debtor, external_id)` y `debtor(tenant, type, external_id)`.
4. Conservar la evidencia de restauracion (fecha, resultado y responsable) antes de continuar.

La tabla `data_import_debt_change` guarda el antes/despues de los campos de deuda afectados por un trabajo. Sirve para auditoria y diagnostico de una importacion, pero **no reemplaza** el respaldo completo ni habilita un rollback automatico.

## Precondiciones para habilitar apply

1. Aplicar y verificar las migraciones en el proyecto de pruebas.
2. Ejecutar las pruebas de unidad y las pruebas de integracion aisladas con datos sintéticos.
3. Verificar que una deuda ausente del CSV se conserva y que una fila incompleta se rechaza.
4. Verificar que repetir el mismo archivo no crea duplicados y que los contadores se mantienen estables.
5. Verificar `data_import_audit_event` y `data_import_debt_change` para el trabajo de prueba.
6. Revisar el backup/restauracion documentado arriba.
7. Autorizar explicitamente al usuario que realizará el ensayo, mediante SQL ejecutado por un administrador de base de datos:

```sql
insert into public.data_import_authorization (
  tenant, app_user, active, can_import, can_apply, granted_by
)
values (1, <ID_USUARIO_AUTORIZADO>, true, true, false, <ID_ADMINISTRADOR>)
on conflict (tenant, app_user) do update
set active = true,
    can_import = true,
    can_apply = false,
    granted_by = excluded.granted_by,
    granted_at = now(),
    revoked_at = null,
    updated_at = now();
```

El primer acceso se limita a `dry_run`; por eso `can_apply` continúa en `false`.

## Habilitacion posterior y controlada

Solo despues de aprobar el ensayo aislado y el respaldo restaurable, un administrador puede habilitar una ventana controlada de apply:

1. Cambiar la autorizacion del usuario elegido a `can_apply=true`.
2. Cambiar `lafalda_import_control.apply_enabled=true` desde SQL Editor con doble validacion operativa.
3. Configurar temporalmente `LAFALDA_IMPORT_APPLY_ENABLED=true` solo en el entorno servidor correspondiente.
4. Encolar un unico archivo previamente validado y monitorear su estado/auditoria.
5. Al finalizar, devolver ambas banderas a `false` y revocar `can_apply`.

La RPC verifica los permisos de nuevo al reclamar el trabajo y al comenzar el merge. Por lo tanto, una autorizacion revocada impide procesar un trabajo aun si ya estaba en cola.

## Recuperacion ante incidente

- Si falla antes del merge: el trabajo se marca `FAILED`, se conserva su historial y puede reintentarse cuando se resuelva la causa.
- Si falla la RPC de merge: PostgreSQL revierte esa llamada completa; no deben quedar deudas actualizadas parcialmente dentro del merge.
- Si falla el recalculo de perfiles despues del merge: no se revierte automaticamente la deuda; el trabajo queda `FAILED` y debe reintentarse antes de usar los perfiles para decisiones. Esta es una condicion operativa a cerrar en el ensayo aislado.
- Ante una modificacion incorrecta confirmada: detener apply, conservar auditoria, restaurar el backup validado en un entorno aislado y seguir el procedimiento municipal de recuperacion. No ejecutar actualizaciones manuales masivas sin una revision aprobada.
