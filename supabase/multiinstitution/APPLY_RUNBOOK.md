# Aplicación real de CSV — Multiinstitución

La aplicación real queda bloqueada por defecto. Para habilitarla de forma
supervisada deben coincidir los tres controles siguientes:

1. `import_authorization.can_apply = true` para la membresía institucional.
2. `import_control.apply_enabled = true` para la institución.
3. La variable del worker `MULTI_IMPORT_APPLY_ENABLED` debe ser exactamente
   `true`. Cualquier otro valor, incluida su ausencia, bloquea el merge.

## Universidad Demo en Testing

1. Instalar la migración
   `migrations/20261123091600_multi_import_apply.sql` en el proyecto que tenga
   el marcador `EQUITAS_MULTIINSTITUTION`.
2. Ejecutar manualmente `testing/enable-universidad-demo-apply.sql`.
3. En el entorno del worker, configurar `MULTI_IMPORT_APPLY_ENABLED=true`.
4. Ejecutar una simulación terminada sin filas rechazadas y confirmar
   **Actualizar deudas** desde la interfaz.
5. Verificar que el trabajo finalice con estado `COMPLETED`, que conserve el
   `simulation_job_id` y que existan sus filas en `import_change`.
6. Ejecutar `testing/disable-universidad-demo-apply.sql` y volver la variable
   del worker a `false` al terminar la prueba.

No se vuelve a subir el CSV: el trabajo `APPLY` referencia el dry-run por
`simulation_job_id`, conserva el mismo hash y utiliza las filas de staging
validadas. Si el merge finaliza y falla el recálculo, el job queda en
`RECALCULATING_PROFILES`; reintentar ese estado ejecuta solo perfiles, nunca el
merge de deudas.

## Variables de servidor

Vercel (API): `MULTI_SUPABASE_SERVICE_ROLE_KEY`,
`MULTI_IMPORT_APPLY_ENABLED`, `GITHUB_MULTI_IMPORT_DISPATCH_TOKEN`,
`GITHUB_MULTI_IMPORT_REPOSITORY`, `GITHUB_MULTI_IMPORT_WORKFLOW_FILE` y
`GITHUB_MULTI_IMPORT_WORKFLOW_REF`.

GitHub Actions: secretos `MULTI_SUPABASE_URL`,
`MULTI_SUPABASE_SERVICE_ROLE_KEY`, `MULTI_SUPABASE_PROJECT_REF`; variable de
repositorio `MULTI_IMPORT_APPLY_ENABLED`. No reutilizar secretos `SUPABASE_*`
de La Falda.
