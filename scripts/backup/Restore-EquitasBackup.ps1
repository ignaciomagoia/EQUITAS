[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$BackupPath,

    [string]$RestoreDatabaseUrl,

    [Parameter(Mandatory)]
    [ValidateSet('RESTORE_ISOLATED_DATABASE')]
    [string]$Confirmation
)

$ErrorActionPreference = 'Stop'

$AllowedRestoreHost = '127.0.0.1'
$AllowedRestorePort = 5432
$AllowedRestoreDatabase = 'equitas_backup_verificacion'

$OperationalTables = @(
    'address',
    'city',
    'contact_type',
    'currency',
    'data_source',
    'data_source_type',
    'debt',
    'debt_status',
    'debtor',
    'debtor_contact',
    'debtor_person',
    'debtor_profile',
    'debtor_profile_detail',
    'debtor_type',
    'document_type',
    'lafalda_import_control',
    'person',
    'person_status',
    'person_type',
    'province',
    'role',
    'telegram_access_link',
    'tenant'
)

$ExcludedTableRoots = @(
    'user',
    'tenant_user',
    'data_import_job',
    'data_import_debt_stage',
    'data_import_row_error'
)

function Require-PostgresCommand {
    param([string]$Name)

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $candidates = Get-ChildItem -LiteralPath 'C:\Program Files\PostgreSQL' -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        ForEach-Object { Join-Path $_.FullName "bin\$Name.exe" }

    $localCommand = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $localCommand) {
        throw "No se encontro $Name. Instale PostgreSQL Client Tools o agreguelo al PATH."
    }

    return $localCommand
}

function Read-DatabaseUrl {
    param([string]$Prompt)

    $secureValue = Read-Host -Prompt $Prompt -AsSecureString
    return [System.Net.NetworkCredential]::new('', $secureValue).Password
}

function Get-ValidatedTarget {
    param([string]$DatabaseUrl)

    try {
        $target = [uri]$DatabaseUrl
    } catch {
        throw 'La URL PostgreSQL del destino no tiene un formato URI valido.'
    }

    if ($target.Scheme -notin @('postgres', 'postgresql')) {
        throw 'El destino debe usar una URL postgres:// o postgresql://.'
    }

    $databaseName = [uri]::UnescapeDataString($target.AbsolutePath.Trim('/'))
    if ($target.Host.ToLowerInvariant() -ne $AllowedRestoreHost -or
        $target.Port -ne $AllowedRestorePort -or
        $databaseName -ne $AllowedRestoreDatabase) {
        throw "Restauracion bloqueada. El unico destino permitido es $AllowedRestoreHost`:$AllowedRestorePort/$AllowedRestoreDatabase."
    }

    return $target
}

function Assert-BackupIntegrity {
    param(
        [string]$ArchivePath,
        [string]$MetadataPath
    )

    if (-not (Test-Path -LiteralPath $MetadataPath)) {
        throw 'Falta el manifiesto del respaldo. No se restaura sin verificar SHA-256.'
    }

    $metadata = Get-Content -LiteralPath $MetadataPath -Raw | ConvertFrom-Json
    if ($metadata.archive_file -ne (Split-Path -Leaf $ArchivePath)) {
        throw 'El manifiesto no corresponde al archivo de respaldo indicado.'
    }

    $expectedHash = ([string]$metadata.archive_sha256).ToUpperInvariant()
    $actualHash = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToUpperInvariant()
    if ([string]::IsNullOrWhiteSpace($expectedHash) -or $actualHash -ne $expectedHash) {
        throw 'El SHA-256 del respaldo no coincide con el manifiesto. La restauracion fue bloqueada.'
    }

    Write-Host 'SHA-256 verificado correctamente.'
}

function Get-ExpectedCounts {
    param([string]$CountsPath)

    if (-not (Test-Path -LiteralPath $CountsPath)) {
        throw 'Faltan los conteos fuente del respaldo. No se restaura sin ellos.'
    }

    $counts = @{}
    Get-Content -LiteralPath $CountsPath | ForEach-Object {
        if (-not [string]::IsNullOrWhiteSpace($_)) {
            $parts = $_ -split ',', 2
            if ($parts.Count -eq 2) {
                $counts[$parts[0]] = $parts[1]
            }
        }
    }

    foreach ($metric in @('tenant_1_debtors', 'tenant_1_debts', 'tenant_1_people', 'tenant_1_profiles')) {
        if (-not $counts.ContainsKey($metric)) {
            throw "Falta la metrica $metric en los conteos fuente."
        }
    }

    return $counts
}

function Get-CountQuery {
    return @'
do $$
declare
    required_table text;
begin
    foreach required_table in array array[
        'tenant', 'person', 'debtor', 'debt', 'debtor_person',
        'debtor_profile', 'debtor_profile_detail'
    ]
    loop
        if to_regclass('public.' || required_table) is null then
            raise exception 'Falta la tabla operativa public.% despues de la restauracion.', required_table;
        end if;
    end loop;
end;
$$;

select 'tenant_1_debtors' as metric, count(*)::text as value
from public.debtor
where tenant = 1
union all
select 'tenant_1_debts', count(*)::text
from public.debt debt
join public.debtor debtor on debtor.id = debt.debtor
where debtor.tenant = 1
union all
select 'tenant_1_people', count(distinct relation.person)::text
from public.debtor_person relation
join public.debtor debtor on debtor.id = relation.debtor
where debtor.tenant = 1
union all
select 'tenant_1_profiles', count(*)::text
from public.debtor_profile profile
join public.debtor debtor on debtor.id = profile.debtor
where debtor.tenant = 1;
'@
}

function New-OperationalRestoreList {
    param(
        [string]$PgRestore,
        [string]$ArchivePath,
        [string]$ListPath
    )

    $archiveList = & $PgRestore '--list' $ArchivePath
    if ($LASTEXITCODE -ne 0) {
        throw "No se pudo leer el contenido del respaldo. pg_restore finalizo con codigo $LASTEXITCODE."
    }

    foreach ($table in $OperationalTables) {
        $escapedTable = [regex]::Escape($table)
        $hasDefinition = @($archiveList | Where-Object { $_ -match " TABLE public $escapedTable " }).Count -gt 0
        $hasData = @($archiveList | Where-Object { $_ -match " TABLE DATA public $escapedTable " }).Count -gt 0
        if (-not $hasDefinition -or -not $hasData) {
            throw "El respaldo no contiene definicion y datos para la tabla operativa public.$table."
        }
    }

    $excludedRoots = ($ExcludedTableRoots | ForEach-Object { [regex]::Escape($_) }) -join '|'
    $excludedObjectPattern = "\bpublic (?:$excludedRoots)(?:\b|_)"

    $filteredList = foreach ($entry in $archiveList) {
        $mustExclude =
            $entry -match $excludedObjectPattern -or
            $entry -match ' SCHEMA - public ' -or
            $entry -match ' FUNCTION public ' -or
            $entry -match ' POLICY public ' -or
            $entry -match ' ROW SECURITY public ' -or
            $entry -match ' EVENT TRIGGER '

        if ($mustExclude) {
            "; $entry"
        } else {
            $entry
        }
    }

    Set-Content -LiteralPath $ListPath -Value $filteredList -Encoding ascii
}

function Assert-LocalTargetConnection {
    param(
        [string]$Psql,
        [string]$DatabaseUrl
    )

    $targetInfo = & $Psql "--dbname=$DatabaseUrl" '--tuples-only' '--no-align' '--field-separator=,' '--set=ON_ERROR_STOP=on' '--command=select current_database(), coalesce(host(inet_server_addr()), '''');'
    if ($LASTEXITCODE -ne 0) {
        throw "No se pudo conectar al destino local. psql finalizo con codigo $LASTEXITCODE."
    }

    $parts = ($targetInfo | Where-Object { $_ -match ',' } | Select-Object -First 1) -split ',', 2
    if ($parts.Count -ne 2 -or $parts[0] -ne $AllowedRestoreDatabase -or $parts[1] -ne $AllowedRestoreHost) {
        throw 'La conexion no confirma el destino local permitido. La restauracion fue bloqueada.'
    }
}

function Reset-VerificationPublicSchema {
    param(
        [string]$Psql,
        [string]$DatabaseUrl
    )

    $resetQuery = 'drop schema if exists public cascade; create schema public;'
    & $Psql "--dbname=$DatabaseUrl" '--single-transaction' '--set=ON_ERROR_STOP=on' "--command=$resetQuery"
    if ($LASTEXITCODE -ne 0) {
        throw "No se pudo reiniciar el esquema public de la base de verificacion. psql finalizo con codigo $LASTEXITCODE."
    }
}

$pgRestore = Require-PostgresCommand 'pg_restore'
$psql = Require-PostgresCommand 'psql'
$metadataPath = [System.IO.Path]::ChangeExtension($BackupPath, '.metadata.json')
$countsPath = [System.IO.Path]::ChangeExtension($BackupPath, '.source-counts.csv')

if ([string]::IsNullOrWhiteSpace($RestoreDatabaseUrl)) {
    $RestoreDatabaseUrl = Read-DatabaseUrl "Pegue la URL de $AllowedRestoreHost`:$AllowedRestorePort/$AllowedRestoreDatabase"
}

[void](Get-ValidatedTarget $RestoreDatabaseUrl)
Assert-BackupIntegrity -ArchivePath $BackupPath -MetadataPath $metadataPath
$expectedCounts = Get-ExpectedCounts -CountsPath $countsPath
Assert-LocalTargetConnection -Psql $psql -DatabaseUrl $RestoreDatabaseUrl

$restoreListPath = Join-Path ([System.IO.Path]::GetTempPath()) "equitas-operational-restore-$PID.list"

try {
    New-OperationalRestoreList -PgRestore $pgRestore -ArchivePath $BackupPath -ListPath $restoreListPath

    Write-Host "Destino confirmado: $AllowedRestoreHost`:$AllowedRestorePort/$AllowedRestoreDatabase"
    Write-Host 'Se eliminara y recreara solamente el esquema public de la base local de verificacion.'
    Write-Host 'No se restauraran Auth, Storage, Vault, RLS, funciones ni el historial de importaciones dependiente de Auth.'

    Reset-VerificationPublicSchema -Psql $psql -DatabaseUrl $RestoreDatabaseUrl

    & $pgRestore '--clean' '--if-exists' '--exit-on-error' '--no-owner' '--no-privileges' '--schema=public' "--use-list=$restoreListPath" "--dbname=$RestoreDatabaseUrl" $BackupPath
    if ($LASTEXITCODE -ne 0) {
        throw "pg_restore finalizo con codigo $LASTEXITCODE. La restauracion no se considera exitosa."
    }

    $actualCounts = @{}
    $restoredCounts = & $psql "--dbname=$RestoreDatabaseUrl" '--tuples-only' '--no-align' '--field-separator=,' '--set=ON_ERROR_STOP=on' "--command=$(Get-CountQuery)"
    if ($LASTEXITCODE -ne 0) {
        throw "No se pudieron leer los conteos restaurados. psql finalizo con codigo $LASTEXITCODE."
    }

    $restoredCounts | ForEach-Object {
        $parts = $_ -split ',', 2
        if ($parts.Count -eq 2 -and -not [string]::IsNullOrWhiteSpace($parts[0])) {
            $actualCounts[$parts[0]] = $parts[1]
        }
    }

    $mismatches = @(
        $expectedCounts.Keys | Where-Object {
            -not $actualCounts.ContainsKey($_) -or $actualCounts[$_] -ne $expectedCounts[$_]
        }
    )
    if ($mismatches.Count -gt 0) {
        $details = $mismatches | ForEach-Object { "$_ esperado=$($expectedCounts[$_]) restaurado=$($actualCounts[$_])" }
        throw "La restauracion termino, pero los conteos no coinciden: $($details -join '; ')"
    }

    Write-Host 'Restauracion operativa verificada: SHA-256 y los cuatro conteos del tenant 1 coinciden.'
} finally {
    Remove-Item -LiteralPath $restoreListPath -Force -ErrorAction SilentlyContinue
}
