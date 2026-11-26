'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { AlertCircle, CheckCircle2, FileSpreadsheet, LoaderCircle, Upload } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  analyzeMultiImportFile,
  MULTI_IMPORT_FIELDS,
  multiImportProgress,
  type MultiImportJob,
  type MultiImportMapping,
  type MultiImportStructure,
} from '@/lib/multi-imports'
import { createBrowserSupabaseClient } from '@/lib/supabase-browser'
import { cn } from '@/lib/utils'

type RowError = { source_row: number; code: string; message: string }
type StagePreview = { source_row: number; normalized_values: Record<string, unknown>; validation_status: string }
type ImportDetail = { job: MultiImportJob; errors: RowError[]; preview: StagePreview[] }
type UploadData = { bucket: string; path: string; token: string }
type ImportDispatchStatus = 'dispatched' | 'failed' | 'not_configured' | 'skipped'

const ACTIVE_STATUSES = new Set(['UPLOADING', 'QUEUED', 'VALIDATING', 'STAGING', 'MERGING', 'RECALCULATING_PROFILES'])
const REQUIRED_MAPPING = new Set(['debtor_external_reference', 'debt_external_reference'])

function formatDate(value: string) {
  return new Intl.DateTimeFormat('es-AR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
}

function formatFileSize(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function statusLabel(status: string) {
  return ({
    UPLOADING: 'Preparando archivo', QUEUED: 'En cola', VALIDATING: 'Validando archivo', STAGING: 'Comparando datos',
    DRY_RUN_COMPLETED: 'Simulación terminada', MERGING: 'Actualizando deudas', RECALCULATING_PROFILES: 'Actualizando perfiles',
    COMPLETED: 'Actualización terminada', COMPLETED_WITH_ERRORS: 'Terminada con observaciones', FAILED: 'Fallida', CANCELLED: 'Cancelada',
  } as Record<string, string>)[status] ?? status
}

async function calculateHash(file: File) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
}

async function readApiError(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null
  return payload?.error ?? 'No se pudo completar la operación solicitada.'
}

export function MultiImportPanel() {
  const [file, setFile] = useState<File | null>(null)
  const [structure, setStructure] = useState<MultiImportStructure | null>(null)
  const [mapping, setMapping] = useState<MultiImportMapping>({})
  const [jobs, setJobs] = useState<MultiImportJob[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<ImportDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [forceNewRun, setForceNewRun] = useState(false)
  const [showAllMappings, setShowAllMappings] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [canApply, setCanApply] = useState(false)
  const selectedRef = useRef<number | null>(null)

  const hasActiveJob = useMemo(() => jobs.some((job) => ACTIVE_STATUSES.has(job.status)), [jobs])
  const missingMapping = useMemo(
    () => [...REQUIRED_MAPPING].filter((field) => !mapping[field]),
    [mapping],
  )
  const fieldsRequiringAttention = useMemo(() => {
    if (!structure) return []
    const ambiguousFields = new Set(Object.keys(structure.ambiguousFields))
    return MULTI_IMPORT_FIELDS.filter(
      (field) => field.required && (!mapping[field.key] || ambiguousFields.has(field.key)),
    )
  }, [mapping, structure])
  const fieldsToReview = useMemo(() => {
    if (!structure) return []
    if (showAllMappings) {
      return MULTI_IMPORT_FIELDS.filter(
        (field) => mapping[field.key] || field.required || structure.ambiguousFields[field.key],
      )
    }
    return fieldsRequiringAttention
  }, [fieldsRequiringAttention, mapping, showAllMappings, structure])

  const loadJobs = useCallback(async () => {
    const response = await fetch('/api/multi-imports', { cache: 'no-store' })
    if (!response.ok) throw new Error(await readApiError(response))
    const payload = await response.json() as { jobs: MultiImportJob[]; capabilities?: { canApply?: boolean } }
    setJobs(payload.jobs)
    setCanApply(payload.capabilities?.canApply === true)
  }, [])

  const loadDetail = useCallback(async (jobId: number) => {
    const response = await fetch(`/api/multi-imports?jobId=${jobId}`, { cache: 'no-store' })
    if (!response.ok) throw new Error(await readApiError(response))
    const payload = await response.json() as ImportDetail
    if (selectedRef.current === jobId) setDetail(payload)
  }, [])

  const refresh = useCallback(async () => {
    try {
      await loadJobs()
      if (selectedRef.current) await loadDetail(selectedRef.current)
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'No se pudo actualizar el historial.')
    } finally {
      setLoading(false)
    }
  }, [loadDetail, loadJobs])

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(timer)
  }, [refresh])
  useEffect(() => {
    if (!jobs.some((job) => ACTIVE_STATUSES.has(job.status))) return
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(timer)
  }, [jobs, refresh])

  async function selectJob(jobId: number) {
    selectedRef.current = jobId
    setSelectedId(jobId)
    setDetail(null)
    try {
      await loadDetail(jobId)
    } catch (detailError) {
      setError(detailError instanceof Error ? detailError.message : 'No se pudo consultar el detalle.')
    }
  }

  async function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null
    setFile(selected)
    setStructure(null)
    setMapping({})
    setShowAllMappings(false)
    setError(null)
    if (!selected) return
    if (!selected.name.toLowerCase().endsWith('.csv')) {
      setError('Seleccioná un archivo CSV.')
      return
    }
    try {
      const analyzed = await analyzeMultiImportFile(selected)
      setStructure(analyzed)
      setMapping(analyzed.mapping)
    } catch (analysisError) {
      setError(analysisError instanceof Error ? analysisError.message : 'No se pudo revisar el archivo.')
    }
  }

  function changeMapping(field: string, header: string) {
    setMapping((current) => {
      const next = { ...current }
      if (!header) delete next[field]
      else {
        for (const [mappedField, mappedHeader] of Object.entries(next)) {
          if (mappedField !== field && mappedHeader === header) delete next[mappedField]
        }
        next[field] = header
      }
      return next
    })
  }

  async function queueJob(jobId: number, action: 'queue' | 'retry' | 'retry_profiles') {
    const response = await fetch('/api/multi-imports', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, jobId }),
    })
    if (!response.ok) throw new Error(await readApiError(response))
    const payload = await response.json() as { dispatch?: { status?: ImportDispatchStatus } }
    await selectJob(jobId)
    await refresh()
    return payload.dispatch?.status ?? 'skipped'
  }

  async function applySimulation(jobId: number) {
    if (!window.confirm('¿Confirmás que querés aplicar los cambios de esta simulación? Esta acción actualizará los datos de tu institución.')) return
    setSubmitting(true)
    setError(null)
    setMessage(null)
    try {
      const response = await fetch('/api/multi-imports', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'apply', jobId }),
      })
      if (!response.ok) throw new Error(await readApiError(response))
      const payload = await response.json() as { job: MultiImportJob; dispatch?: { status?: ImportDispatchStatus } }
      setMessage(
        payload.dispatch?.status === 'dispatched'
          ? 'Actualización confirmada. Se procesará el resultado de la simulación validada.'
          : 'Actualización confirmada y en cola. Se recuperará automáticamente en la próxima ejecución programada.'
      )
      await selectJob(payload.job.id)
      await refresh()
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : 'No se pudo iniciar la actualización.')
    } finally {
      setSubmitting(false)
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setMessage(null)
    if (!file || !structure) {
      setError('Seleccioná un archivo CSV y revisá sus columnas.')
      return
    }
    if (missingMapping.length) {
      setError('Completá los identificadores del objeto y de la deuda antes de continuar.')
      return
    }
    if (hasActiveJob) {
      setError('Ya hay una simulación en curso para tu institución.')
      return
    }
    setSubmitting(true)
    try {
      const contentHash = await calculateHash(file)
      const create = await fetch('/api/multi-imports', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create', fileName: file.name, fileSize: file.size, contentHash,
          headers: structure.headers, mapping, encoding: structure.encoding, delimiter: structure.delimiter,
          forceNewDryRun: forceNewRun,
        }),
      })
      if (!create.ok) throw new Error(await readApiError(create))
      const created = await create.json() as { job: MultiImportJob; reused?: boolean; upload?: UploadData }
      if (created.reused) {
        setMessage('El archivo ya fue simulado. Se muestra su resultado anterior.')
        await selectJob(created.job.id)
        return
      }
      if (!created.upload) throw new Error('No se pudo preparar la carga privada del archivo.')
      const supabase = createBrowserSupabaseClient('multi')
      if (!supabase) throw new Error('No se pudo iniciar la conexión de carga institucional.')
      const upload = await supabase.storage.from(created.upload.bucket).uploadToSignedUrl(
        created.upload.path, created.upload.token, file, { contentType: 'text/csv' },
      )
      if (upload.error) throw new Error('No se pudo subir el CSV al almacenamiento privado.')
      const dispatchStatus = await queueJob(created.job.id, 'queue')
      setMessage(
        dispatchStatus === 'dispatched'
          ? 'Archivo recibido. Se realizará una simulación sin modificar personas, objetos ni deudas.'
          : 'Archivo recibido y en cola. Se recuperará automáticamente en la próxima ejecución programada.'
      )
      setFile(null)
      setStructure(null)
      setMapping({})
      setForceNewRun(false)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'No se pudo iniciar la simulación.')
    } finally {
      setSubmitting(false)
    }
  }

  const summary = detail?.job.dry_run_summary ?? {}

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Importar archivo de deudas</CardTitle>
          <CardDescription>Revisá las columnas y simulá los cambios antes de actualizar datos.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit}>
            <input type="file" accept=".csv,text/csv" onChange={onFileChange} disabled={submitting || hasActiveJob} />
            {structure ? (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
                <p className="font-medium text-slate-800">Archivo preparado: {structure.headers.length} columnas detectadas.</p>
                <p className="mt-1 text-xs text-slate-600">
                  {fieldsRequiringAttention.length
                    ? 'Necesitamos confirmar algunas columnas indispensables antes de continuar.'
                    : 'Las columnas indispensables fueron identificadas automáticamente. Podés ejecutar la simulación.'}
                </p>
                {fieldsToReview.length > 0 ? (
                  <details className="mt-4 rounded-md border border-slate-200 bg-white p-3" open={showAllMappings || fieldsRequiringAttention.length > 0}>
                    <summary className="cursor-pointer text-sm font-medium text-[#163a63]">Revisar configuración de columnas</summary>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      {fieldsToReview.map((field) => (
                        <label key={field.key} className="grid gap-1 text-xs text-slate-700">
                          <span className={field.required ? 'font-semibold text-[#163a63]' : ''}>{field.label}{field.required ? ' *' : ''}</span>
                          <select value={mapping[field.key] ?? ''} onChange={(event) => changeMapping(field.key, event.target.value)} className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm">
                            <option value="">No usar esta columna</option>
                            {structure.headers.map((header) => <option key={header} value={header}>{header}</option>)}
                          </select>
                        </label>
                      ))}
                    </div>
                  </details>
                ) : null}
                <button type="button" className="mt-3 text-xs font-medium text-[#163a63] underline underline-offset-2" onClick={() => setShowAllMappings((current) => !current)}>
                  {showAllMappings ? 'Ocultar configuración detectada' : 'Revisar configuración de columnas'}
                </button>
                {Object.keys(structure.ambiguousFields).length ? <p className="mt-3 text-xs text-amber-800">Las columnas ambiguas no se usarán hasta que las confirmes.</p> : null}
                {missingMapping.length ? <p className="mt-3 text-xs text-red-700">Faltan identificadores obligatorios para comparar datos.</p> : null}
              </div>
            ) : null}
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <input type="checkbox" checked={forceNewRun} onChange={(event) => setForceNewRun(event.target.checked)} />
              Volver a simular aunque el archivo ya esté en el historial.
            </label>
            <Button type="submit" disabled={submitting || hasActiveJob || !structure}>
              {submitting ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4" />}
              Ejecutar simulación
            </Button>
          </form>
        </CardContent>
      </Card>

      {message ? <div className="flex gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"><CheckCircle2 className="size-4" />{message}</div> : null}
      {error ? <div className="flex gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"><AlertCircle className="size-4" />{error}</div> : null}

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.8fr)]">
        <Card><CardHeader><CardTitle>Historial de importaciones</CardTitle></CardHeader><CardContent>
          {loading ? <p className="text-sm text-slate-500">Cargando historial...</p> : jobs.length === 0 ? <p className="text-sm text-slate-500">Todavía no hay importaciones registradas.</p> : <div className="space-y-3">
            {jobs.map((job) => {
              const progress = multiImportProgress(job)
              return <button key={job.id} type="button" onClick={() => void selectJob(job.id)} className={cn('w-full rounded-lg border p-3 text-left', selectedId === job.id ? 'border-[#163a63] bg-slate-50' : 'border-slate-200 bg-white')}>
                <p className="truncate text-sm font-semibold text-slate-900">{job.file_name}</p><p className="mt-1 text-xs text-slate-500">{formatDate(job.created_at)} · {formatFileSize(job.file_size_bytes)}</p>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-200"><div className="h-full bg-[#163a63]" style={{ width: `${progress}%` }} /></div>
                <p className="mt-1 text-xs text-slate-600">{statusLabel(job.status)} · {job.processed_rows} de {job.total_rows || '...'} registros</p>
              </button>
            })}
          </div>}
        </CardContent></Card>

        <Card><CardHeader><CardTitle>Resultado de la importación</CardTitle><CardDescription>{detail?.job.mode === 'APPLY' ? 'La actualización se realiza a partir de una simulación validada.' : 'La simulación no modifica datos operativos.'}</CardDescription></CardHeader><CardContent>
          {!detail ? <p className="text-sm text-slate-500">Seleccioná una importación para ver su resultado.</p> : <div className="space-y-4">
            <p className="text-sm font-semibold text-slate-900">{statusLabel(detail.job.status)}</p>
            <div className="grid grid-cols-2 gap-2 text-sm"><p>Nuevas <strong className="float-right">{detail.job.inserted_rows}</strong></p><p>Actualizadas <strong className="float-right">{detail.job.updated_rows}</strong></p><p>Sin cambios <strong className="float-right">{detail.job.unchanged_rows}</strong></p><p>Rechazadas <strong className="float-right">{detail.job.rejected_rows}</strong></p></div>
            {typeof summary.people_new === 'number' ? <p className="text-xs text-slate-600">Personas nuevas: {summary.people_new} · Objetos nuevos: {String(summary.debtors_new ?? 0)}</p> : null}
            {detail.job.ignored_columns.length ? <p className="text-xs text-slate-600">Columnas no utilizadas: {detail.job.ignored_columns.join(', ')}</p> : null}
            {detail.job.error_message ? <p className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">{detail.job.error_message}</p> : null}
            {detail.job.status === 'FAILED' ? <Button size="sm" variant="outline" onClick={() => void queueJob(detail.job.id, 'retry')}>Reintentar importación</Button> : null}
            {detail.job.status === 'RECALCULATING_PROFILES' && detail.job.merge_completed_at ? <Button size="sm" variant="outline" onClick={() => void queueJob(detail.job.id, 'retry_profiles')}>Reintentar actualización de perfiles</Button> : null}
            {detail.job.mode === 'DRY_RUN' && detail.job.status === 'DRY_RUN_COMPLETED' && detail.job.rejected_rows === 0 ? (
              canApply ? <Button size="sm" onClick={() => void applySimulation(detail.job.id)} disabled={submitting || hasActiveJob}>Actualizar deudas</Button> : <p className="text-xs text-slate-500">La actualización real está bloqueada por seguridad para esta institución.</p>
            ) : null}
            {detail.preview.length ? <div className="space-y-2"><p className="text-sm font-semibold">Vista previa de cambios</p><div className="max-h-64 overflow-auto rounded border border-slate-200"><table className="w-full text-left text-xs"><thead className="sticky top-0 bg-slate-50 text-slate-600"><tr><th className="px-2 py-1.5">Fila</th><th className="px-2 py-1.5">Objeto</th><th className="px-2 py-1.5">Deuda</th><th className="px-2 py-1.5">Resultado</th></tr></thead><tbody>{detail.preview.map((item) => <tr key={item.source_row} className="border-t border-slate-100"><td className="px-2 py-1.5">{item.source_row}</td><td className="px-2 py-1.5">{String(item.normalized_values._dry_run && typeof item.normalized_values._dry_run === 'object' ? (item.normalized_values._dry_run as Record<string, unknown>).debtor_external_reference ?? '—' : '—')}</td><td className="px-2 py-1.5">{String(item.normalized_values._dry_run && typeof item.normalized_values._dry_run === 'object' ? (item.normalized_values._dry_run as Record<string, unknown>).debt_external_reference ?? '—' : '—')}</td><td className="px-2 py-1.5">{String(item.normalized_values._dry_run && typeof item.normalized_values._dry_run === 'object' ? (item.normalized_values._dry_run as Record<string, unknown>).comparison ?? 'VALIDADA' : 'VALIDADA')}</td></tr>)}</tbody></table></div></div> : null}
            {detail.errors.length ? <div className="space-y-2"><p className="text-sm font-semibold">Errores de filas</p>{detail.errors.map((item) => <p key={`${item.source_row}-${item.code}`} className="rounded border border-slate-200 p-2 text-xs">Fila {item.source_row}: {item.message}</p>)}</div> : null}
          </div>}
        </CardContent></Card>
      </section>
      <p className="flex gap-2 text-xs text-slate-500"><FileSpreadsheet className="size-4" />Las actualizaciones reales requieren una simulación sin errores y autorización institucional.</p>
    </div>
  )
}
