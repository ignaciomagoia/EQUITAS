'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { AlertCircle, CheckCircle2, FileSpreadsheet, LoaderCircle, Upload } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { createBrowserSupabaseClient } from '@/lib/supabase-browser'
import {
  buildImportCreatePayload,
  calculateImportProgress,
  importModeLabel,
  shouldUpdateSelectedImportDetail,
  type ImportJob,
  type ImportMode,
} from '@/lib/imports'
import { cn } from '@/lib/utils'

type ImportRowError = {
  source_row: number
  code: string
  message: string
  source_key: Record<string, number | null>
}

type ImportDetail = {
  job: ImportJob
  errors: ImportRowError[]
}

type UploadData = {
  bucket: string
  path: string
  token: string
}

const ACTIVE_STATUSES = new Set([
  'UPLOADING',
  'QUEUED',
  'VALIDATING',
  'STAGING',
  'MERGING',
  'RECALCULATING_PROFILES',
])

function formatDate(value: string) {
  return new Intl.DateTimeFormat('es-AR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value))
}

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    UPLOADING: 'Esperando archivo',
    QUEUED: 'En cola',
    VALIDATING: 'Validando',
    STAGING: 'Preparando comparacion',
    MERGING: 'Actualizando deudas',
    RECALCULATING_PROFILES: 'Recalculando perfiles',
    DRY_RUN_COMPLETED: 'Simulacion terminada',
    COMPLETED: 'Importacion terminada',
    COMPLETED_WITH_ERRORS: 'Terminada con observaciones',
    FAILED: 'Fallida',
    CANCELLED: 'Cancelada',
  }

  return labels[status] ?? status
}

async function calculateHash(file: File) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function readApiError(response: Response) {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null
  return payload?.error ?? 'No se pudo completar la operacion solicitada.'
}

export function ImportPanel({ applyEnabled }: { applyEnabled: boolean }) {
  const [file, setFile] = useState<File | null>(null)
  const [jobs, setJobs] = useState<ImportJob[]>([])
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null)
  const [selectedJob, setSelectedJob] = useState<ImportDetail | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [importMode, setImportMode] = useState<ImportMode>('dry_run')
  const [forceNewDryRun, setForceNewDryRun] = useState(false)
  const [applyConfirmed, setApplyConfirmed] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const selectedJobIdRef = useRef<number | null>(null)
  const detailRequestIdRef = useRef(0)

  const selectedId = selectedJobId
  const hasActiveJob = useMemo(() => jobs.some((job) => ACTIVE_STATUSES.has(job.status)), [jobs])

  const loadJobs = useCallback(async () => {
    const response = await fetch('/api/imports', { cache: 'no-store' })

    if (!response.ok) {
      throw new Error(await readApiError(response))
    }

    const payload = (await response.json()) as { jobs: ImportJob[] }
    setJobs(payload.jobs)
  }, [])

  const loadJobDetail = useCallback(async (jobId: number) => {
    const requestId = detailRequestIdRef.current + 1
    detailRequestIdRef.current = requestId
    const response = await fetch(`/api/imports?jobId=${jobId}`, { cache: 'no-store' })

    if (!response.ok) {
      throw new Error(await readApiError(response))
    }

    const payload = (await response.json()) as ImportDetail
    const isLatestRequest = requestId === detailRequestIdRef.current

    if (shouldUpdateSelectedImportDetail(selectedJobIdRef.current, jobId, isLatestRequest)) {
      setSelectedJob(payload)
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      setError(null)
      await loadJobs()
      const currentSelectedJobId = selectedJobIdRef.current
      if (currentSelectedJobId) await loadJobDetail(currentSelectedJobId)
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'No se pudo actualizar el historial.')
    } finally {
      setIsLoading(false)
    }
  }, [loadJobDetail, loadJobs])

  useEffect(() => {
    const timeout = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(timeout)
  }, [refresh])

  useEffect(() => {
    if (!jobs.some((job) => ACTIVE_STATUSES.has(job.status))) return

    const interval = window.setInterval(() => void refresh(), 2500)
    return () => window.clearInterval(interval)
  }, [jobs, refresh])

  const selectJob = useCallback(async (jobId: number) => {
    selectedJobIdRef.current = jobId
    setSelectedJobId(jobId)
    setSelectedJob(null)

    try {
      setError(null)
      await loadJobDetail(jobId)
    } catch (detailError) {
      if (selectedJobIdRef.current === jobId) {
        setError(detailError instanceof Error ? detailError.message : 'No se pudo consultar el detalle.')
      }
    }
  }, [loadJobDetail])

  async function enqueueExistingJob(jobId: number, action: 'queue' | 'retry') {
    const response = await fetch('/api/imports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, jobId }),
    })

    if (!response.ok) throw new Error(await readApiError(response))

    await selectJob(jobId)
    await refresh()
  }

  async function submitFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage(null)
    setError(null)

    if (!file) {
      setError('Selecciona un archivo CSV para continuar.')
      return
    }

    if (hasActiveJob) {
      setError('Ya hay una importacion en curso para este municipio.')
      return
    }

    if (importMode === 'apply' && !applyConfirmed) {
      setError('Confirma que vas a aplicar una actualización real antes de continuar.')
      return
    }

    setIsSubmitting(true)

    try {
      const contentHash = await calculateHash(file)
      const createResponse = await fetch('/api/imports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          buildImportCreatePayload(file.name, file.size, contentHash, importMode, forceNewDryRun),
        ),
      })

      if (!createResponse.ok) throw new Error(await readApiError(createResponse))

      const created = (await createResponse.json()) as {
        job: ImportJob
        reused?: boolean
        upload?: UploadData
      }

      if (created.reused) {
        setMessage('Ese archivo ya figura en el historial. Se muestra su resultado existente.')
        await selectJob(created.job.id)
        await refresh()
        return
      }

      if (!created.upload) throw new Error('No se recibio una autorizacion de carga privada.')

      const supabase = createBrowserSupabaseClient()
      if (!supabase) throw new Error('No se pudo iniciar la conexion de carga.')

      const uploadResponse = await supabase.storage
        .from(created.upload.bucket)
        .uploadToSignedUrl(created.upload.path, created.upload.token, file, {
          contentType: 'text/csv',
        })

      if (uploadResponse.error) throw new Error('No se pudo subir el CSV al almacenamiento privado.')

      await enqueueExistingJob(created.job.id, 'queue')
      setMessage(
        importMode === 'apply'
          ? 'Archivo recibido. La actualización real solo continuará si los controles del worker y de la base de datos están habilitados.'
          : 'Archivo recibido. El worker realizará la comparación sin modificar deudas.',
      )
      setFile(null)
      setForceNewDryRun(false)
      setApplyConfirmed(false)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'No se pudo iniciar la importacion.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{importMode === 'apply' ? 'Aplicar actualización diaria' : 'Simular actualización diaria'}</CardTitle>
          <CardDescription>
            {importMode === 'apply'
              ? 'La aplicación real requiere autorización del usuario, worker habilitado y confirmación en la base de datos.'
              : 'Compara el CSV con los datos de La Falda. No inserta ni modifica deudas.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4 md:flex-row md:items-end" onSubmit={submitFile}>
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <fieldset className="grid gap-2">
                <legend className="text-sm font-medium text-slate-700">Modo de importación</legend>
                <label className="flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700">
                  <input
                    type="radio"
                    name="import-mode"
                    value="dry_run"
                    checked={importMode === 'dry_run'}
                    onChange={() => {
                      setImportMode('dry_run')
                      setApplyConfirmed(false)
                    }}
                    disabled={isSubmitting || hasActiveJob}
                  />
                  <span>
                    <strong className="block text-slate-900">Simular (dry-run)</strong>
                    Compara el archivo sin modificar deudas.
                  </span>
                </label>
                {applyEnabled ? (
                  <label className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950">
                    <input
                      type="radio"
                      name="import-mode"
                      value="apply"
                      checked={importMode === 'apply'}
                      onChange={() => {
                        setImportMode('apply')
                        setForceNewDryRun(false)
                      }}
                      disabled={isSubmitting || hasActiveJob}
                    />
                    <span>
                      <strong className="block">Aplicar actualización real (apply)</strong>
                      Actualiza únicamente las deudas identificadas en el CSV cuando todos los controles externos estén habilitados.
                    </span>
                  </label>
                ) : (
                  <p className="text-xs text-slate-500">La actualización real está deshabilitada en este entorno.</p>
                )}
              </fieldset>
              <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
                Archivo CSV
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                  className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm file:mr-3 file:border-0 file:bg-[#f6efdc] file:px-2 file:py-1 file:text-xs file:font-semibold file:text-[#5f4a19]"
                  disabled={isSubmitting || hasActiveJob}
                />
                <span className="text-xs font-normal text-slate-500">
                  Separador coma o punto y coma; UTF-8, UTF-8 BOM o Windows-1252; hasta 100 MB. Campos requeridos: tipo de bien, cuenta e identificador de deuda.
                </span>
              </label>
              {importMode === 'dry_run' ? (
                <label className="flex items-center gap-2 text-xs font-normal text-slate-600">
                  <input
                    type="checkbox"
                    checked={forceNewDryRun}
                    onChange={(event) => setForceNewDryRun(event.target.checked)}
                    disabled={isSubmitting || hasActiveJob}
                  />
                  Ejecutar una nueva simulación aunque el archivo ya figure en el historial.
                </label>
              ) : (
                <label className="flex items-center gap-2 text-xs font-normal text-amber-950">
                  <input
                    type="checkbox"
                    checked={applyConfirmed}
                    onChange={(event) => setApplyConfirmed(event.target.checked)}
                    disabled={isSubmitting || hasActiveJob}
                  />
                  Confirmo que revisé el resultado esperado y quiero solicitar la actualización real.
                </label>
              )}
            </div>
            <Button type="submit" disabled={isSubmitting || hasActiveJob || (importMode === 'apply' && !applyConfirmed)} className="shrink-0">
              {isSubmitting ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4" />}
              {importMode === 'apply' ? 'Solicitar actualización real' : 'Ejecutar simulación'}
            </Button>
          </form>
          {hasActiveJob ? (
            <p className="mt-3 text-xs text-amber-800">
              Hay una importacion en curso. Espera su finalizacion antes de cargar otro archivo.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {message ? (
        <div className="flex gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
          {message}
        </div>
      ) : null}
      {error ? (
        <div className="flex gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          {error}
        </div>
      ) : null}

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.8fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Historial de importaciones</CardTitle>
            <CardDescription>Los archivos iguales se detectan mediante su huella SHA-256.</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-sm text-slate-500">Cargando historial...</p>
            ) : jobs.length === 0 ? (
              <p className="text-sm text-slate-500">Todavia no hay importaciones registradas.</p>
            ) : (
              <div className="space-y-3">
                {jobs.map((job) => {
                  const progress = calculateImportProgress(job)
                  const isSelected = selectedId === job.id

                  return (
                    <button
                      key={job.id}
                      type="button"
                      onClick={() => void selectJob(job.id)}
                      className={cn(
                        'w-full rounded-lg border p-3 text-left transition hover:border-[#7692b4] hover:bg-slate-50',
                        isSelected ? 'border-[#163a63] bg-slate-50' : 'border-slate-200 bg-white'
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-slate-900">{job.file_name}</p>
                          <p className="mt-0.5 text-xs text-slate-500">
                            {formatDate(job.created_at)} · {formatFileSize(job.file_size_bytes)}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1 text-xs font-medium">
                          <span className={cn('rounded-full px-2 py-0.5', job.mode === 'apply' ? 'bg-amber-100 text-amber-900' : 'bg-slate-100 text-slate-700')}>
                            {importModeLabel(job.mode)}
                          </span>
                          <span className="text-[#163a63]">{statusLabel(job.status)}</span>
                        </div>
                      </div>
                      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-200">
                        <div className="h-full rounded-full bg-[#163a63] transition-all" style={{ width: `${progress}%` }} />
                      </div>
                      <p className="mt-1.5 text-xs text-slate-600">
                        {job.processed_rows} de {job.total_rows || '...'} registros · {progress}%
                      </p>
                    </button>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Detalle de la importacion</CardTitle>
            <CardDescription>Resultados de validacion y comparacion por archivo.</CardDescription>
          </CardHeader>
          <CardContent>
            {!selectedJob ? (
              <p className="text-sm text-slate-500">Selecciona una importacion del historial para ver su resultado.</p>
            ) : (
              <div className="space-y-4">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-slate-900">{statusLabel(selectedJob.job.status)}</p>
                      <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', selectedJob.job.mode === 'apply' ? 'bg-amber-100 text-amber-900' : 'bg-slate-200 text-slate-700')}>
                        {importModeLabel(selectedJob.job.mode)}
                      </span>
                    </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                    <p className="text-slate-600">Nuevas <strong className="float-right text-slate-900">{selectedJob.job.inserted_rows}</strong></p>
                    <p className="text-slate-600">Actualizadas <strong className="float-right text-slate-900">{selectedJob.job.updated_rows}</strong></p>
                    <p className="text-slate-600">Sin cambios <strong className="float-right text-slate-900">{selectedJob.job.unchanged_rows}</strong></p>
                    <p className="text-slate-600">Rechazadas <strong className="float-right text-slate-900">{selectedJob.job.rejected_rows}</strong></p>
                  </div>
                </div>
                {selectedJob.job.ignored_columns?.length ? (
                  <p className="text-xs text-slate-600">
                    Columnas ignoradas: {selectedJob.job.ignored_columns.join(', ')}.
                  </p>
                ) : null}
                {selectedJob.job.error_message ? (
                  <p className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800">
                    {selectedJob.job.error_message}
                  </p>
                ) : null}
                {selectedJob.job.status === 'UPLOADING' ? (
                  <Button size="sm" variant="outline" onClick={() => void enqueueExistingJob(selectedJob.job.id, 'queue')}>
                    Encolar archivo ya cargado
                  </Button>
                ) : null}
                {selectedJob.job.status === 'FAILED' ? (
                  <Button size="sm" variant="outline" onClick={() => void enqueueExistingJob(selectedJob.job.id, 'retry')}>
                    {selectedJob.job.mode === 'apply' ? 'Reintentar actualización real' : 'Reintentar simulación'}
                  </Button>
                ) : null}
                {selectedJob.errors.length ? (
                  <div>
                    <p className="mb-2 text-sm font-semibold text-slate-900">Errores de filas</p>
                    <div className="max-h-56 space-y-2 overflow-y-auto">
                      {selectedJob.errors.map((rowError) => (
                        <div key={`${rowError.source_row}-${rowError.code}`} className="rounded-md border border-slate-200 p-2 text-xs">
                          <p className="font-medium text-slate-800">Fila {rowError.source_row}: {rowError.code}</p>
                          <p className="mt-0.5 text-slate-600">{rowError.message}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      <p className="flex items-start gap-2 text-xs text-slate-500">
        <FileSpreadsheet className="mt-0.5 size-4 shrink-0" />
        La aplicación no elimina obligaciones que no aparezcan en el archivo. Una actualización real requiere autorización del usuario y controles habilitados en Vercel, GitHub Actions y Supabase.
      </p>
    </div>
  )
}
