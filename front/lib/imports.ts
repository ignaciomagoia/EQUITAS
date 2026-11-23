export const LAFALDA_IMPORT_BUCKET = 'lafalda-imports'
export const LAFALDA_IMPORT_JOB_TABLE = 'data_import_job'
export const LAFALDA_IMPORT_ERROR_TABLE = 'data_import_row_error'

export type ImportMode = 'dry_run' | 'apply'

export type ImportCreatePayload = {
  action: 'create'
  fileName: string
  fileSize: number
  contentHash: string
  mode: ImportMode
  forceNewDryRun: boolean
}

export type ImportAuthorization = {
  active: boolean
  canImport: boolean
  canApply: boolean
}

export type ImportJob = {
  id: number
  file_name: string
  file_size_bytes: number
  mode: ImportMode
  status: string
  total_rows: number
  processed_rows: number
  inserted_rows: number
  updated_rows: number
  unchanged_rows: number
  rejected_rows: number
  ignored_columns: string[]
  error_message: string | null
  created_at: string
  completed_at: string | null
}

export function isImportMode(value: unknown): value is ImportMode {
  return value === 'dry_run' || value === 'apply'
}

export function buildImportCreatePayload(
  fileName: string,
  fileSize: number,
  contentHash: string,
  mode: ImportMode,
  forceNewDryRun: boolean,
): ImportCreatePayload {
  return {
    action: 'create',
    fileName,
    fileSize,
    contentHash,
    mode,
    forceNewDryRun: mode === 'dry_run' && forceNewDryRun,
  }
}

export function importModeLabel(mode: ImportMode) {
  return mode === 'apply' ? 'Actualizar deudas' : 'Simular actualización'
}

export function getLafaldaImportTenantId() {
  const value = Number(process.env.LAFALDA_IMPORT_TENANT_ID)

  return Number.isSafeInteger(value) && value > 0 ? value : null
}

export function isLafaldaApplyEnabled() {
  return process.env.LAFALDA_IMPORT_APPLY_ENABLED === 'true'
}

export function canUseImportMode(
  authorization: ImportAuthorization | null,
  mode: ImportMode,
  applyEnabled = isLafaldaApplyEnabled(),
) {
  if (!authorization?.active || !authorization.canImport) {
    return false
  }

  return mode === 'dry_run' || (applyEnabled && authorization.canApply)
}

export function shouldUpdateSelectedImportDetail(
  selectedJobId: number | null,
  detailJobId: number,
  isLatestRequest: boolean,
) {
  return isLatestRequest && selectedJobId === detailJobId
}

export function calculateImportProgress(job: Pick<ImportJob, 'status' | 'total_rows' | 'processed_rows'>) {
  if (job.status === 'COMPLETED' || job.status === 'COMPLETED_WITH_ERRORS' || job.status === 'DRY_RUN_COMPLETED') {
    return 100
  }

  if (job.total_rows <= 0) {
    return 0
  }

  return Math.min(95, Math.round((job.processed_rows / job.total_rows) * 90))
}
