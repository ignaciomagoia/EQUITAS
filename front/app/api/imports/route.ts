import { createHash } from 'node:crypto'

import {
  getLafaldaImportTenantId,
  isLafaldaApplyEnabled,
  isImportMode,
  canUseImportMode,
  LAFALDA_IMPORT_BUCKET,
  LAFALDA_IMPORT_ERROR_TABLE,
  LAFALDA_IMPORT_JOB_TABLE,
  type ImportJob,
} from '@/lib/imports'
import { dispatchLafaldaCsvImport, shouldDispatchImportWorkflow } from '@/lib/github-import-dispatcher'
import { validateAuthUserTenantAccess } from '@/lib/services/auth-service'
import { createServerAdminSupabaseClient, createServerSupabaseClient } from '@/lib/supabase-server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_IMPORT_FILE_SIZE_BYTES = 100 * 1024 * 1024

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status })
}

function asImportJob(value: unknown): ImportJob {
  return value as ImportJob
}

function sanitizeFileName(value: string) {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160) || 'importacion.csv'
}

async function getImportContext() {
  // La importacion automatica actual pertenece exclusivamente al entorno legado de La Falda.
  const sessionClient = await createServerSupabaseClient('legacy')
  const adminClient = createServerAdminSupabaseClient('legacy')
  const enabledTenantId = getLafaldaImportTenantId()

  if (!sessionClient || !adminClient) {
    return { error: jsonError('La integracion de importaciones no esta configurada.', 503) }
  }

  if (!enabledTenantId) {
    return {
      error: jsonError(
        'La importacion de La Falda permanece deshabilitada hasta configurar LAFALDA_IMPORT_TENANT_ID.',
        503
      ),
    }
  }

  const {
    data: { user },
    error: authError,
  } = await sessionClient.auth.getUser()

  if (authError || !user) {
    return { error: jsonError('Sesion requerida.', 401) }
  }

  const access = await validateAuthUserTenantAccess(user.id, sessionClient)

  if (!access.isAuthorized || !access.context) {
    return { error: jsonError('No tenes permisos de importacion.', 403) }
  }

  const tenantId = Number(access.context.tenantId)
  const appUserId = Number(access.context.appUserId)

  if (!Number.isSafeInteger(tenantId) || !Number.isSafeInteger(appUserId)) {
    return { error: jsonError('No se pudo resolver el tenant de la sesion.', 403) }
  }

  if (tenantId !== enabledTenantId) {
    return { error: jsonError('La importacion solo esta habilitada para La Falda.', 403) }
  }

  const authorizationResponse = await adminClient
    .from('data_import_authorization')
    .select('active,can_import,can_apply')
    .eq('tenant', tenantId)
    .eq('app_user', appUserId)
    .maybeSingle()

  if (authorizationResponse.error) {
    return { error: jsonError('No se pudo validar la autorizacion de importacion.', 503) }
  }

  const authorization = authorizationResponse.data
    ? {
        active: authorizationResponse.data.active,
        canImport: authorizationResponse.data.can_import,
        canApply: authorizationResponse.data.can_apply,
      }
    : null

  if (!canUseImportMode(authorization, 'dry_run')) {
    return { error: jsonError('No tenes una autorizacion activa para importar archivos.', 403) }
  }

  return { adminClient, tenantId, appUserId, authorization }
}

export async function GET(request: Request) {
  const context = await getImportContext()

  if ('error' in context) {
    return context.error
  }

  const { searchParams } = new URL(request.url)
  const jobId = Number(searchParams.get('jobId'))
  const query = context.adminClient
    .from(LAFALDA_IMPORT_JOB_TABLE)
    .select(
      'id,file_name,file_size_bytes,mode,status,total_rows,processed_rows,inserted_rows,updated_rows,unchanged_rows,rejected_rows,ignored_columns,error_message,created_at,completed_at'
    )
    .eq('tenant', context.tenantId)

  if (Number.isSafeInteger(jobId) && jobId > 0) {
    const jobResponse = await query.eq('id', jobId).maybeSingle()

    if (jobResponse.error) {
      return jsonError('No se pudo consultar la importacion.', 500)
    }

    if (!jobResponse.data) {
      return jsonError('La importacion solicitada no existe.', 404)
    }

    const errorsResponse = await context.adminClient
      .from(LAFALDA_IMPORT_ERROR_TABLE)
      .select('source_row,code,message,source_key')
      .eq('job', jobId)
      .order('source_row')
      .limit(200)

    if (errorsResponse.error) {
      return jsonError('No se pudo consultar los errores de la importacion.', 500)
    }

    return Response.json(
      { job: asImportJob(jobResponse.data), errors: errorsResponse.data ?? [] },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  }

  const response = await query.order('created_at', { ascending: false }).limit(20)

  if (response.error) {
    return jsonError('La infraestructura de importaciones no esta instalada.', 503)
  }

  return Response.json(
    { jobs: (response.data ?? []).map(asImportJob) },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}

export async function POST(request: Request) {
  const context = await getImportContext()

  if ('error' in context) {
    return context.error
  }

  let payload: Record<string, unknown>
  try {
    payload = (await request.json()) as Record<string, unknown>
  } catch {
    return jsonError('El cuerpo de la solicitud no es valido.', 400)
  }

  const action = payload.action

  if (action === 'queue' || action === 'retry') {
    const jobId = Number(payload.jobId)

    if (!Number.isSafeInteger(jobId) || jobId <= 0) {
      return jsonError('La importacion indicada no es valida.', 400)
    }

    const existingResponse = await context.adminClient
      .from(LAFALDA_IMPORT_JOB_TABLE)
      .select('id,status,mode')
      .eq('id', jobId)
      .eq('tenant', context.tenantId)
      .maybeSingle()

    if (existingResponse.error || !existingResponse.data) {
      return jsonError('La importacion indicada no existe.', 404)
    }

    const allowedStatus = action === 'queue' ? 'UPLOADING' : 'FAILED'

    if (existingResponse.data.status !== allowedStatus) {
      return jsonError('La importacion no se encuentra en un estado que permita encolarla.', 409)
    }

    if (!canUseImportMode(context.authorization, existingResponse.data.mode, isLafaldaApplyEnabled())) {
      return jsonError('Las importaciones confirmadas no estan habilitadas.', 403)
    }

    const response = await context.adminClient
      .from(LAFALDA_IMPORT_JOB_TABLE)
      .update({
        status: 'QUEUED',
        error_message: null,
        processed_rows: 0,
        inserted_rows: 0,
        updated_rows: 0,
        unchanged_rows: 0,
        rejected_rows: 0,
        completed_at: null,
      })
      .eq('id', jobId)
      .eq('tenant', context.tenantId)
      .select(
        'id,file_name,file_size_bytes,mode,status,total_rows,processed_rows,inserted_rows,updated_rows,unchanged_rows,rejected_rows,ignored_columns,error_message,created_at,completed_at'
      )
      .single()

    if (response.error) {
      return jsonError('No se pudo encolar la importacion.', 500)
    }

    const dispatch = shouldDispatchImportWorkflow(existingResponse.data.status, response.data.status)
      ? await dispatchLafaldaCsvImport(response.data.id)
      : { status: 'skipped' as const }

    return Response.json({ job: asImportJob(response.data), dispatch })
  }

  if (action !== 'create') {
    return jsonError('La accion solicitada no es valida.', 400)
  }

  const fileName = typeof payload.fileName === 'string' ? payload.fileName.trim() : ''
  const fileSize = Number(payload.fileSize)
  const contentHash = typeof payload.contentHash === 'string' ? payload.contentHash.toLowerCase() : ''
  const mode = payload.mode
  const forceNewDryRun = payload.forceNewDryRun === true

  if (!fileName.toLowerCase().endsWith('.csv')) {
    return jsonError('Solo se permiten archivos CSV.', 400)
  }

  if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || fileSize > MAX_IMPORT_FILE_SIZE_BYTES) {
    return jsonError('El archivo debe tener un tamaÃ±o entre 1 byte y 100 MB.', 400)
  }

  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    return jsonError('No se pudo validar la huella SHA-256 del archivo.', 400)
  }

  if (!isImportMode(mode)) {
    return jsonError('El modo de importacion no es valido.', 400)
  }

  if (!canUseImportMode(context.authorization, mode, isLafaldaApplyEnabled())) {
    return jsonError('Las importaciones confirmadas no estan habilitadas.', 403)
  }

  const existingResponse = await context.adminClient
    .from(LAFALDA_IMPORT_JOB_TABLE)
    .select(
      'id,file_name,file_size_bytes,mode,status,total_rows,processed_rows,inserted_rows,updated_rows,unchanged_rows,rejected_rows,ignored_columns,error_message,created_at,completed_at'
    )
    .eq('tenant', context.tenantId)
    .eq('content_sha256', contentHash)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existingResponse.error) {
    return jsonError('No se pudo verificar el historial de importaciones.', 500)
  }

  const canRepeatDryRun =
    forceNewDryRun &&
    mode === 'dry_run' &&
    ['DRY_RUN_COMPLETED', 'FAILED', 'CANCELLED'].includes(existingResponse.data?.status ?? '')

  if (existingResponse.data && !canRepeatDryRun) {
    return Response.json({ job: asImportJob(existingResponse.data), reused: true })
  }

  const safeFileName = sanitizeFileName(fileName)
  const pathHash = createHash('sha256')
    .update(`${context.tenantId}:${contentHash}:${safeFileName}`)
    .digest('hex')
    .slice(0, 16)
  const storagePath = `tenant-${context.tenantId}/${Date.now()}-${pathHash}-${safeFileName}`
  const createResponse = await context.adminClient
    .from(LAFALDA_IMPORT_JOB_TABLE)
    .insert({
      tenant: context.tenantId,
      requested_by: context.appUserId,
      file_name: safeFileName,
      storage_path: storagePath,
      content_sha256: contentHash,
      file_size_bytes: fileSize,
      mode,
      status: 'UPLOADING',
    })
    .select(
      'id,file_name,file_size_bytes,mode,status,total_rows,processed_rows,inserted_rows,updated_rows,unchanged_rows,rejected_rows,ignored_columns,error_message,created_at,completed_at'
    )
    .single()

  if (createResponse.error || !createResponse.data) {
    if (createResponse.error?.code === '23505') {
      return jsonError('Ya existe una importacion activa para este municipio.', 409)
    }

    return jsonError('No se pudo registrar la importacion.', 500)
  }

  const signedUpload = await context.adminClient.storage
    .from(LAFALDA_IMPORT_BUCKET)
    .createSignedUploadUrl(storagePath, { upsert: false })

  if (signedUpload.error || !signedUpload.data) {
    await context.adminClient
      .from(LAFALDA_IMPORT_JOB_TABLE)
      .update({ status: 'FAILED', error_message: 'No se pudo preparar la carga privada del archivo.' })
      .eq('id', createResponse.data.id)

    return jsonError('No se pudo preparar la carga privada del archivo.', 500)
  }

  return Response.json({
    job: asImportJob(createResponse.data),
    upload: {
      bucket: LAFALDA_IMPORT_BUCKET,
      path: storagePath,
      token: signedUpload.data.token,
    },
  })
}
