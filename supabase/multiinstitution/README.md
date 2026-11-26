# EQUITAS Multiinstitucion

Estas migraciones pertenecen exclusivamente a la segunda plataforma Supabase de
EQUITAS. No deben ejecutarse en el proyecto historico de La Falda.

## Proteccion de destino

La primera migracion exige que los esquemas `public` y `private` no tengan
objetos heredados, que no existan usuarios Auth ni objetos Storage y que no se
detecten las tablas historicas `tenant`, `debtor` o `debt`. Estas condiciones
bloquean el proyecto productivo historico de La Falda y cualquier entorno sin
reinicializar. No depende de `ALTER DATABASE` ni de una variable de sesion.

La primera migracion crea el marcador persistente `platform_installation` con
la clave `EQUITAS_MULTIINSTITUTION`. Todas las migraciones posteriores lo
validan antes de realizar cambios.

La aplicacion de migraciones en un proyecto remoto queda pendiente hasta crear
el proyecto Supabase multiinstitucion y ejecutar un preflight manual.

## Orden

Aplicar los archivos de `migrations/` en orden lexicografico. No contienen
datos institucionales, usuarios municipales ni configuraciones de importacion.

## Importación CSV genérica (solo simulación)

La migración `20261123091400_multi_import_dry_run.sql` agrega el resumen de
simulación a `import_job` y bloquea `APPLY` desde la base de datos, incluso si
la invocación usa `service_role`. Debe instalarse **solo** después de las
migraciones `90000` a `91300` y únicamente en la plataforma marcada como
`EQUITAS_MULTIINSTITUTION`.

El frontend crea trabajos con `mode = DRY_RUN`, guarda el archivo en el bucket
privado `equitas-multi-imports` y persiste el mapeo elegido en una versión de
perfil propia de la institución. El worker independiente se ejecuta con:

```powershell
cd back
.\.venv\Scripts\python.exe -m ETL.multi_csv_worker --once
```

Su `back/.env` requiere `MULTI_SUPABASE_URL`, `MULTI_SUPABASE_PROJECT_REF` y
`MULTI_SUPABASE_SERVICE_ROLE_KEY` del proyecto Multiinstitución. El worker
comprueba que la URL coincide con ese project ref y que existe el marcador de
plataforma antes de reclamar trabajos. No reutilizar las credenciales de La
Falda ni exponer la service role en `front/.env.local`.
Hasta incorporar un workflow dedicado, el worker debe iniciarse manualmente;
la automatización de GitHub Actions queda deliberadamente pendiente.
# Etapa 1: bootstrap y datos ficticios

Despues de instalar las migraciones `20261123090000` a `20261123091000`, instale tambien
`migrations/20261123091100_multi_bootstrap_first_platform_admin.sql`,
`migrations/20261123091200_multi_initial_institution_provisioning.sql` y
`migrations/20261123091300_multi_institution_member_administration.sql`.

La migracion `91100` reserva una RPC para el futuro primer `platform_admin`; no debe usarse
para Universidad Demo. La migracion `91200` agrega la provision inicial de una institucion y
su administrador institucional, sin crear ningun rol global. Ambas RPC son inaccesibles para
`anon` y `authenticated`; solo estan disponibles para `service_role` y para la ejecucion
administrativa controlada desde SQL Editor.

Los scripts de `testing/` son exclusivos de `EQUITAS-TP-TESTING`:

1. `verify-initial-provisioning-preflight.sql`: solo lectura; debe mostrar el marcador
   multiinstitucion y cero instituciones, membresias y roles de plataforma.
2. `provision-first-institution-admin.sql`: reemplace el UUID por un usuario creado manualmente
   en Supabase Auth y ejecútelo una vez. Crea Universidad Demo y su `institution_admin`.
3. `diagnose-university-demo-provisioning.sql`: si el seed informa una configuracion
   incompleta, reemplace el UUID y ejecute esta consulta de solo lectura.
4. `seed-multiinstitution-fixtures.sql`: reemplace su unico UUID por la misma cuenta Auth;
   crea datos operativos ficticios minimos, sin crear membresias ni privilegios.
5. `verify-multiinstitution-bootstrap.sql` y `verify-multiinstitution-fixtures.sql`: solo lectura.
6. `verify-multiinstitution-rls.sql`: crea temporalmente otra institucion dentro de una
   transaccion y demuestra que el administrador universitario no puede leerla ni administrarla.
   Siempre finaliza con `ROLLBACK`.

No ejecute estos scripts en la base de La Falda ni reutilice cuentas o datos reales.
