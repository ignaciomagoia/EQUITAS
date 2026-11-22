# Preparacion de EQUITAS-TP-TESTING

Este directorio sirve unicamente para el proyecto Supabase gratuito de pruebas. No se aplica en produccion.

## Proyecto de Testing ya existente

Si `EQUITAS-TP-TESTING` ya contiene las tablas de EQUITAS y datos ficticios,
no se deben repetir las migraciones del esquema base ni borrar registros. Usar
estos archivos, en este orden, desde el SQL Editor del proyecto de Testing:

1. `supabase/testing/diagnostico_lafalda_apply_fixture.sql` (solo lectura).
2. Si no faltan tablas o RPCs, `supabase/testing/lafalda_apply_fixture_catalogs.sql`.
3. `supabase/testing/lafalda_apply_fixture.sql`.

El segundo archivo solo agrega, si faltan, el bucket privado y catalogos
sinteticos exclusivos del fixture. No actualiza ni elimina registros existentes.
Si el diagnostico informa `FALTA_TABLA` o `FALTA_FUNCION`, no continuar: falta
aplicar la migracion indicada en la seccion siguiente.

## Esquema requerido para un proyecto vacio

En el SQL Editor de un proyecto nuevo y sin tablas de negocio en `public`, ejecutar los archivos siguientes **en este orden**, uno por uno:

1. `supabase/migrations/20261021220156_equitas_testing_schema.sql`
2. `supabase/migrations/20261021221030_active_membership_rls.sql`
3. `supabase/migrations/20261115170000_telegram_access_links.sql`
4. `supabase/migrations/20261121190000_lafalda_csv_imports.sql`
5. `supabase/migrations/20261122110000_lafalda_import_authorization_audit.sql`
6. `supabase/testing/lafalda_apply_fixture_catalogs.sql`
7. `supabase/testing/lafalda_apply_fixture.sql`

El primer archivo exige que el esquema `public` este vacio. Si el proyecto de testing ya contiene tablas de negocio, no se deben borrar datos ni reutilizarlo para esta prueba: crear otro proyecto limpio.

El archivo de fixture agrega exclusivamente datos sinteticos y dos RPC de testing. No es una migracion de produccion.

## Secretos de GitHub Actions

Crear en el repositorio estos secretos, todos del proyecto **EQUITAS-TP-TESTING**:

- `SUPABASE_TESTING_URL`: URL base del proyecto, sin `/rest/v1`.
- `SUPABASE_TESTING_SERVICE_ROLE_KEY`: service role del proyecto de testing.
- `SUPABASE_TESTING_PROJECT_REF`: project ref visible en Settings > General.

No reutilizar ninguna URL ni clave del proyecto de produccion.

## Ejecucion

Abrir Actions > `Prueba aislada de apply CSV` > Run workflow e ingresar exactamente el valor de `SUPABASE_TESTING_PROJECT_REF` como `project_ref`.

La prueba crea y procesa dos CSV en Storage privado: el primero inserta una deuda, actualiza dos y conserva una ausente; el segundo repite el mismo contenido para verificar idempotencia. Al final elimina los trabajos y vuelve a dejar `lafalda_import_control.apply_enabled=false`.
