[CmdletBinding()]
param(
    [string]$BackupDirectory = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'EQUITAS-backups'),
    [string]$ProductionDatabaseUrl = $env:EQUITAS_PRODUCTION_DATABASE_URL
)

$ErrorActionPreference = 'Stop'

function Require-Command {
    param([string]$Name)

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) {
        throw "No se encontro $Name en PATH. Instale PostgreSQL Client Tools y abra una nueva terminal."
    }

    return $command.Source
}

function Get-DatabaseHost {
    param([string]$DatabaseUrl)

    try {
        return ([uri]$DatabaseUrl).Host.ToLowerInvariant()
    } catch {
        throw 'La URL de conexión PostgreSQL no tiene un formato URI válido.'
    }
}

function Read-DatabaseUrl {
    param([string]$Prompt)

    $secureValue = Read-Host -Prompt $Prompt -AsSecureString
    return [System.Net.NetworkCredential]::new('', $secureValue).Password
}

function Get-CountQuery {
    return @'
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

if ([string]::IsNullOrWhiteSpace($ProductionDatabaseUrl)) {
    $ProductionDatabaseUrl = Read-DatabaseUrl 'Pegá la URL PostgreSQL de Producción'
}

$pgDump = Require-Command 'pg_dump'
$pgRestore = Require-Command 'pg_restore'
$psql = Require-Command 'psql'
$sourceHost = Get-DatabaseHost $ProductionDatabaseUrl

New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupBaseName = "equitas-production-$timestamp"
$backupPath = Join-Path $BackupDirectory "$backupBaseName.dump"
$countsPath = Join-Path $BackupDirectory "$backupBaseName.source-counts.csv"
$archiveListPath = Join-Path $BackupDirectory "$backupBaseName.archive-list.txt"
$metadataPath = Join-Path $BackupDirectory "$backupBaseName.metadata.json"

function Read-MetricCounts {
    param([string]$DatabaseUrl)

    $counts = & $psql "--dbname=$DatabaseUrl" '--tuples-only' '--no-align' '--field-separator=,' '--set=ON_ERROR_STOP=on' "--command=$(Get-CountQuery)"
    if ($LASTEXITCODE -ne 0) {
        throw "No se pudieron registrar los conteos de origen. Código $LASTEXITCODE."
    }

    return @($counts)
}

Write-Host 'Registrando conteos de origen...'
$sourceCountsBefore = Read-MetricCounts $ProductionDatabaseUrl

Write-Host "Exportando respaldo lógico desde $sourceHost..."
& $pgDump "--dbname=$ProductionDatabaseUrl" '--format=custom' '--no-owner' '--no-privileges' "--file=$backupPath"
if ($LASTEXITCODE -ne 0) {
    Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
    throw "pg_dump finalizó con código $LASTEXITCODE. No se conserva un respaldo parcial."
}

Write-Host 'Verificando el archivo con pg_restore --list...'
& $pgRestore '--list' $backupPath | Set-Content -LiteralPath $archiveListPath -Encoding utf8
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $archiveListPath)) {
    throw "pg_restore no pudo leer el archivo de respaldo. Código $LASTEXITCODE."
}

Write-Host 'Verificando que los conteos no hayan cambiado durante el dump...'
$sourceCountsAfter = Read-MetricCounts $ProductionDatabaseUrl
if (($sourceCountsBefore -join "`n") -cne ($sourceCountsAfter -join "`n")) {
    throw 'Los datos principales cambiaron durante el dump. Repetí el respaldo en una ventana sin escrituras.'
}

$sourceCountsBefore | Set-Content -LiteralPath $countsPath -Encoding utf8
$metadata = [ordered]@{
    created_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    source_host = $sourceHost
    archive_file = (Split-Path -Leaf $backupPath)
    archive_sha256 = (Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash
    source_counts_file = (Split-Path -Leaf $countsPath)
    archive_list_file = (Split-Path -Leaf $archiveListPath)
}
$metadata | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding utf8

Write-Host 'Respaldo creado y verificado.'
Write-Host "Archivo: $backupPath"
Write-Host "SHA-256: $($metadata.archive_sha256)"
Write-Host "Conteos: $countsPath"
Write-Host "Manifiesto: $metadataPath"
