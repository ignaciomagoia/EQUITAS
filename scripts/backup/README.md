# Respaldo restaurable de Producción

Estos scripts no leen archivos `.env`, no registran credenciales y no escriben en
Producción. El respaldo se guarda por defecto en `Documentos\EQUITAS-backups`,
fuera del repositorio Git.

## Requisito local

Instalar **PostgreSQL Client Tools** para Windows y comprobar en una nueva
PowerShell:

```powershell
pg_dump --version
pg_restore --version
psql --version
```

En el Dashboard de Supabase Producción, abrir **Connect** y copiar la cadena de
conexión de base de datos. Usar la contraseña de base de datos, no la service
role key. No guardar esa URL en ningún archivo.

## Crear el respaldo

En PowerShell, dentro de esta carpeta:

```powershell
.\scripts\backup\Export-EquitasProductionBackup.ps1
```

El script solicita la URL con entrada oculta. No la copies en `.env`, GitHub ni
en el historial del repositorio.

El script crea un archivo `.dump`, su SHA-256, un listado verificable del
archivo y los conteos de `debtor`, `debt`, personas y perfiles del tenant 1.

## Restaurar y comparar en un destino aislado

Crear antes una base vacía que no sea Producción ni `EQUITAS-TP-TESTING`. Lo más
compatible es un tercer proyecto Supabase temporal; también puede ser una base
PostgreSQL local vacía. Obtener su URL de conexión y la URL de Testing solo para
bloquearla como destino.

```powershell
$backup = Get-ChildItem "$HOME\Documents\EQUITAS-backups\*.dump" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1 -ExpandProperty FullName
$testingHost = 'PROJECT_REF_DE_EQUITAS_TP_TESTING.supabase.co'

.\scripts\backup\Restore-EquitasBackup.ps1 `
  -BackupPath $backup `
  -BlockedRestoreHost $testingHost `
  -Confirmation RESTORE_ISOLATED_DATABASE
```

El script solicita con entrada oculta la URL del destino aislado.

La restauración se bloquea si el host de destino coincide con Producción o con
el host de Testing indicado. El script usa `pg_restore --clean` solo sobre ese
destino aislado y luego compara los conteos registrados al crear el respaldo.

## Alcance

Un `pg_dump` incluye esquema y datos PostgreSQL. Los archivos de Supabase
Storage no forman parte del respaldo de base: conservar por separado el CSV
municipal que se vaya a aplicar y cualquier archivo privado indispensable.
