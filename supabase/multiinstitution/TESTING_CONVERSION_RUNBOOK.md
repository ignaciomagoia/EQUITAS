# Conversión segura de `EQUITAS-TP-TESTING` a Multiinstitución

## Alcance y regla principal

Este procedimiento reutiliza el proyecto cloud denominado actualmente
`EQUITAS-TP-TESTING` **solo después de respaldarlo y vaciarlo de forma
deliberada**. No afecta el proyecto de Producción de La Falda, sus datos ni el
workflow `Importacion CSV La Falda`.

Las once migraciones de `migrations/` fueron diseñadas para una base sin el
modelo legado: la primera aborta si detecta `public.tenant`, `public.debtor` o
`public.debt`. No se debe intentar instalarlas sobre los fixtures actuales ni
usar `db push` sobre ese proyecto sin una reinicialización previa.

## Aislamiento preparado en esta rama

- `.github/workflows/lafalda-csv-import.yml` se conserva sin cambios: utiliza
  únicamente `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` de Producción.
- `lafalda-csv-apply-testing.yml` quedó como workflow manual informativo: no
  recibe secretos, no instala el worker y no puede escribir en Supabase.
- `preview-smoke.yml` quedó manual e informativo: no se dispara tras CI ni usa
  `SUPABASE_TEST_CONFIG`.
- `quality-ci.yml` conserva pruebas unitarias, build, lint y controles locales;
  la integración HTTP histórica contra Testing deja de ejecutarse.
- `supabase/config.toml` usa un identificador local neutral. No ejecutar
  `supabase link` hasta comprobar el proyecto remoto que corresponda.

Los archivos de `supabase/testing/`, `quality/supabase-testing.json`, las
pruebas externas y la documentación de calidad son evidencia histórica. No son
compatibles con el esquema multiinstitución y no deben ejecutarse contra la
nueva base.

## Inventario de secretos y variables

### Conservar sin cambios: Producción La Falda

| Ubicación | Valores a conservar |
| --- | --- |
| GitHub Actions | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PRODUCTION_PROJECT_REF`, variable `LAFALDA_IMPORT_APPLY_ENABLED` |
| Vercel Production | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `LAFALDA_IMPORT_TENANT_ID`, `LAFALDA_IMPORT_APPLY_ENABLED`, `GITHUB_*` si se usa el disparador de importación y variables de Telegram existentes |

No reutilizar ninguno de esos valores para Multiinstitución.

### Retirar después de confirmar el respaldo de Testing

En GitHub Actions, revocar o renombrar fuera de los workflows activos:

- `SUPABASE_TESTING_URL`
- `SUPABASE_TESTING_SERVICE_ROLE_KEY`
- `SUPABASE_TESTING_PROJECT_REF`
- `SUPABASE_TEST_CONFIG`

En Vercel, revisar los ámbitos **Preview** y **Development** y eliminar las
variables que apunten al ref antiguo de Testing. No modificar el ámbito
Production de La Falda. Retirar el bypass de Vercel solo si se confirma que no
es usado por otra automatización.

### Crear más adelante, para Multiinstitución

Usar nombres explícitos y nuevos; no asignarlos todavía a la aplicación actual:

- `MULTI_SUPABASE_URL`
- `MULTI_SUPABASE_PUBLISHABLE_KEY`
- `MULTI_SUPABASE_SERVICE_ROLE_KEY` (solo worker/servidor)
- `MULTI_SUPABASE_PROJECT_REF`

## Paso 1: verificar identidad y contenido, sin escritura

1. En el SQL Editor del proyecto que se va a convertir, ejecutar
   [`testing-conversion-preflight.sql`](testing-conversion-preflight.sql).
2. Guardar o exportar el resultado junto con la fecha y el project ref visible
   en **Settings > General**.
3. Confirmar manualmente que no es el project ref ni la URL de Producción.
4. Verificar que el inventario muestre las tablas, funciones, usuarios Auth y
   buckets de fixtures que se desean conservar en el respaldo.

## Paso 2: respaldo verificable antes de reinicializar

### Variante aprobada: fixtures descartables sin respaldo

Para la conversión actual se autorizó descartar definitivamente los fixtures,
usuarios Auth y objetos Storage de Testing. En lugar del respaldo de esta
sección, ejecutar únicamente el procedimiento controlado de
[`testing-reset-legacy.sql`](testing-reset-legacy.sql), después de verificar la
identidad del proyecto en el panel. El script exige la firma de fixtures
sintéticos y aborta antes de borrar si no la encuentra.

#### Orden obligatorio de la variante sin respaldo

1. Ejecutar [`testing-reset-readiness.sql`](testing-reset-readiness.sql) y
   comprobar `expected_fixture_debt_count = 2` y que no exista el marcador
   multiinstitución.
2. En **Storage**, eliminar con la interfaz de Supabase cada objeto de cada
   bucket y luego cada bucket. No usar `DELETE` SQL sobre `storage.objects` ni
   `storage.buckets`.
3. Ejecutar `testing-reset-readiness.sql` otra vez y comprobar ambos conteos de
   Storage en cero.
4. Ejecutar [`testing-reset-legacy.sql`](testing-reset-legacy.sql). Este paso
   borra solamente el esquema público legado, tras validar los fixtures y
   Storage vacío.
5. En **Authentication > Users**, eliminar las cuentas sintéticas con la
   interfaz oficial. No usar `DELETE` SQL sobre `auth.users`.
6. Ejecutar [`testing-empty-verification.sql`](testing-empty-verification.sql).
   Solo continuar si devuelve cero usuarios, buckets y objetos, y `NULL` para
   las tablas legadas, el marcador multi y el esquema `private`.

Para conservar datos en una conversión futura, mantener el procedimiento de
backup que sigue a continuación.

1. Publicar primero los workflows ya aislados y comprobar que ninguno puede
   escribir en Testing.
2. Generar un backup lógico completo del proyecto Testing con `pg_dump` desde
   una conexión de base de datos de **ese** project ref. Guardarlo fuera de Git,
   por ejemplo `Documentos\EQUITAS-backups\testing-legacy-AAAAmmdd.dump`.
3. Calcular SHA-256 y conservar `pg_restore --list` junto al dump.
4. Exportar aparte los objetos de Supabase Storage necesarios: un dump
   PostgreSQL conserva metadatos, no necesariamente archivos físicos.
5. Restaurar el dump en una base PostgreSQL aislada y comparar las tablas de
   fixtures, usuarios que correspondan y el inventario de Storage.
6. Detener la conversión si el respaldo no puede restaurarse y verificarse.

Los scripts de `scripts/backup/` son referencia de seguridad, pero fueron
preparados para Producción La Falda; no usar sus conteos como validación del
proyecto Testing.

## Paso 3: condiciones previas a borrar los datos antiguos

- [ ] La identidad de Testing fue comprobada con el diagnóstico de solo lectura.
- [ ] Se autorizó explícitamente descartar los fixtures sin respaldo, o se
      verificó un backup restaurable si se eligió conservarlos.
- [ ] Los workflows históricos aislados se publicaron y no consumen secretos.
- [ ] Se inventariaron referencias de Vercel Preview y Development.
- [ ] Se preservaron evidencias académicas fuera de la futura base.
- [ ] Existe ventana de mantenimiento y responsable del reset.
- [ ] Está confirmado que Producción La Falda no está seleccionado en Supabase.

## Paso 4: reinicialización y migraciones (procedimiento futuro)

La reinicialización es destructiva y se ejecutará manualmente solo al cumplir el
paso anterior. Para la variante sin respaldo, seguir el orden obligatorio de la
sección anterior. El reset no modifica Storage ni Auth directamente: esos
servicios se vacían mediante las interfaces oficiales antes y después del reset
del esquema público, respectivamente.

Luego, en el SQL Editor del proyecto ya vacío:

1. Confirmar mediante `testing-empty-verification.sql` que no quedan tablas,
   funciones, usuarios Auth, buckets ni objetos del modelo anterior.
2. No ejecutar `ALTER DATABASE`, `SET LOCAL` ni `set_config()` como guard de
   instalación: Supabase no permite persistir ese parámetro desde SQL Editor y
   las alternativas de sesión no sobreviven una conexión nueva. La primera
   migración valida el entorno vacío de forma persistente mediante el marcador
   que crea.
3. Ejecutar, en orden lexical, las 11 migraciones de `migrations/` desde
   `20261123090000` hasta `20261123091000`.
4. Verificar `public.platform_installation`, las políticas RLS y el bucket
   privado `equitas-multi-imports`.
5. Crear el primer usuario Auth e institución mediante un flujo administrativo
   que se implementará y probará en una etapa posterior.

## Compatibilidad de las migraciones con una base vacía

La revisión estática confirmó orden por dependencia, guard de plataforma y que
no reutilizan tablas legadas. Falta validarlas en PostgreSQL/Supabase real: este
repositorio no tiene instancia local de Supabase ni `psql`/`sqlfluff`, así que
todavía no existe validación de ejecución SQL local o remota.

## Qué no hacer

- No ejecutar migraciones multiinstitución en Producción La Falda.
- No ejecutar fixtures de `supabase/testing/` después del reset.
- No restaurar el backup de Testing sobre Producción ni la futura base multi.
- No copiar claves service role a cliente, `.env` versionados o logs.
