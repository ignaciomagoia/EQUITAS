# Prueba aislada de aplicación de CSV

## Decisión de infraestructura

Se recomienda **Supabase local mediante Docker y Supabase CLI**. El repositorio ya contiene `supabase/config.toml` y las migraciones necesarias, por lo que esta alternativa evita crear cuentas, copiar datos o compartir secretos de producción. Un proyecto Supabase cloud separado sería una alternativa válida para pruebas compartidas del equipo, pero no es necesario para la primera integración.

El entorno local se identifica como `equitas-tp-testing`, usa API en `http://127.0.0.1:54321` y PostgreSQL en el puerto `54322`. No debe ejecutarse `supabase link` ni utilizarse una URL de producción.

## Componentes reproducidos

- Esquema principal y RLS: `supabase/migrations/20261021220156_equitas_testing_schema.sql` y `supabase/migrations/20261021221030_active_membership_rls.sql`.
- Tablas de importación, bloqueo, RPC y bucket privado: `supabase/migrations/20261121190000_lafalda_csv_imports.sql`.
- Bucket `lafalda-imports`: privado, admite `text/csv` y tiene límite de 100 MiB.
- RPC requeridas por el worker: `claim_lafalda_import_job`, `prepare_lafalda_import_stage`, `summarize_lafalda_import_stage` y `apply_lafalda_import_stage`.
- Worker: `ETL/daily_csv_worker.py`, ejecutado con service role **local**.

El flujo actual no necesita políticas directas sobre `storage.objects`: la interfaz solicita un enlace firmado desde el servidor con service role y el worker descarga con service role. Usuarios autenticados no tienen acceso directo al bucket.

## Datos sintéticos

`supabase/seed.local_apply.sql` crea solo datos ficticios:

- tenant local `1`, operador local y catálogos mínimos;
- un objeto `Bien_Tipo_Id=1`, `Cuenta=700001`;
- tres deudas base para probar actualización, modificación parcial y conservación de una deuda ausente.

El esquema de pruebas versionado no declaraba generación automática para algunos IDs, mientras que el worker inserta sin proporcionar esos IDs. El seed agrega identidades **solo a la base local** para `debt` y perfiles; no cambia migraciones ni producción. Antes de usar un entorno cloud de testing se debe confirmar que esos defaults/identidades existen en el esquema objetivo.

## Casos cubiertos por la integración opt-in

`tests/integration/test_local_apply_worker.py` cubre, con CSV y Storage sintéticos:

1. El bloqueo de base de datos impide `apply` con `apply_enabled=false` aun para service role.
2. Inserción de una deuda nueva.
3. Actualización de importes y descripción de una deuda existente.
4. Actualización parcial sin reemplazar importes ausentes.
5. Conservación de una deuda existente que no aparece en el CSV.
6. Procesamiento completo del worker: Storage privado, hash, staging, RPC, merge y recalculo de perfil.

La prueba está deshabilitada por defecto y solo se ejecuta con una URL cuyo host sea `localhost`, `127.0.0.1` o `::1`.

## Pasos manuales pendientes

1. Instalar Supabase CLI y comprobarlo con `supabase --version`. Docker ya debe estar iniciado.
2. Desde la raíz del repositorio, ejecutar `supabase start`.
3. Ejecutar `supabase db reset` para aplicar migraciones y el seed local sintético.
4. Ejecutar `supabase status -o env` y copiar únicamente el `SERVICE_ROLE_KEY` local en un archivo no versionado `back/local-supabase.env`, tomando `back/local-supabase.env.example` como modelo.
5. En PowerShell, desde `back`, cargar las variables locales y habilitar explícitamente la prueba:

```powershell
$env:EQUITAS_ENV_FILE = "$PWD\local-supabase.env"
$env:EQUITAS_LOCAL_SUPABASE_URL = "http://127.0.0.1:54321"
$env:EQUITAS_LOCAL_SUPABASE_SERVICE_ROLE_KEY = "<SERVICE_ROLE_KEY_LOCAL>"
$env:EQUITAS_RUN_LOCAL_APPLY_TESTS = "true"
.\.venv\Scripts\python.exe -m pytest tests/integration/test_local_apply_worker.py -m local_supabase
```

La prueba habilita `lafalda_import_control.apply_enabled` solamente durante su ejecución local y lo devuelve a `false` en el bloque de limpieza. No se debe usar `LAFALDA_IMPORT_APPLY_ENABLED=true` en producción.

### Prueba opcional desde la interfaz

La integración preparada prueba el worker directamente con service role local. Para recorrer además `/imports` desde el navegador se necesita crear un usuario de **Auth local**, vincular su UUID en `public.user.auth_user` y crear su membresía `tenant_user` para el tenant sintético. Luego se deben usar en `front/.env.local` únicamente la URL, publishable key y service role locales. El botón de `apply` debe habilitarse solo de forma temporal en ese archivo local y junto con el control de base local; nunca con valores de producción.

## Criterios de éxito

- Resultado del job: `COMPLETED`, 1 inserción, 2 actualizaciones y 0 rechazos.
- La deuda parcial conserva importes originales.
- La deuda ausente conserva su saldo y descripción.
- El job, archivo temporal y deuda nueva se eliminan al finalizar; el control queda bloqueado.
