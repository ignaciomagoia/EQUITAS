import { createHash } from 'node:crypto'

import {
  MULTI_IMPORT_BUCKET,
  MULTI_IMPORT_MAX_FILE_SIZE,
  MULTI_IMPORT_FIELDS,
  type MultiImportMapping,
} from '@/lib/multi-imports'
import { dispatchMultiInstitutionCsvImport } from '@/lib/github-multi-import-dispatcher'
import { validateMultiInstitutionAccess } from '@/lib/services/multi-auth-service'
import { createMultiServerAdminSupabaseClient, createServerSupabaseClient } from '@/lib/supabase-server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const PROFILE_CODE = 'generic-csv'

type ImportContext = {
  adminClient: NonNullable<ReturnType<typeof createMultiServerAdminSupabaseClient>>
  institutionId: number
  membershipId: number
  userId: string
  canApply: boolean
}

type IdentitySchemeSnapshot = {
  debtor: number
  debt: number
  person: number | null
}

type SupabaseOperationError = {
  code?: string
  message?: string
  details?: string | null
  hint?: string | null
}

function jsonError(error: string, status: number) {
  return Response.json({ error }, { status })
}

function describeSupabaseError(action: string, error: SupabaseOperationError | null | undefined) {
  const code = typeof error?.code === 'string' ? ` (${error.code})` : ''
  const message = typeof error?.message === 'string' ? error.message : 'Error desconocido de Supabase.'
  const details = typeof error?.details === 'string' && error.details ? ` Detalle: ${error.details}` : ''
  const hint = typeof error?.hint === 'string' && error.hint ? ` Sugerencia: ${error.hint}` : ''
  return `${action}${code}: ${message}${details}${hint}`
}

function sanitizeFileName(value: string) {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160) || 'importacion.csv'
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isProfileEncoding(value: unknown): value is 'UTF-8' | 'UTF-8-SIG' | 'WINDOWS-1252' {
  return value === 'UTF-8' || value === 'UTF-8-SIG' || value === 'WINDOWS-1252'
}

function isDelimiter(value: unknown): value is ',' | ';' | '\t' {
  return value === ',' || value === ';' || value === '\t'
}

function normalizeMapping(value: unknown, headers: unknown): MultiImportMapping | null {
  if (!value || typeof value !== 'object' || !Array.isArray(headers)) return null
  const knownFields = new Set<string>(MULTI_IMPORT_FIELDS.map((field) => field.key))
  const knownHeaders = new Set(headers.filter((header): header is string => typeof header === 'string'))
  const mapping = Object.entries(value as Record<string, unknown>)
  const normalized: MultiImportMapping = {}
  const usedHeaders = new Set<string>()
  for (const [field, header] of mapping) {
    if (!knownFields.has(field) || typeof header !== 'string' || !knownHeaders.has(header)) return null
    if (usedHeaders.has(header)) return null
    normalized[field] = header
    usedHeaders.add(header)
  }
  return normalized.debtor_external_reference && normalized.debt_external_reference ? normalized : null
}

function mappingSignature(mapping: MultiImportMapping) {
  return JSON.stringify(Object.entries(mapping).sort(([left], [right]) => left.localeCompare(right)))
}

function importFieldMetadata(canonicalField: string) {
  const field = MULTI_IMPORT_FIELDS.find((candidate) => candidate.key === canonicalField)
  if (!field) throw new Error(`Campo de importacion desconocido: ${canonicalField}`)
  if (canonicalField.startsWith('person_')) {
    return { target_entity: canonicalField === 'person_email' || canonicalField === 'person_phone' ? 'CONTACT' : 'PERSON', data_type: canonicalField === 'person_external_reference' || canonicalField === 'person_document_number' ? 'IDENTIFIER' : 'TEXT' }
  }
  if (canonicalField.startsWith('debtor_') || canonicalField === 'object_type') {
    return { target_entity: 'DEBTOR', data_type: canonicalField.includes('reference') || canonicalField === 'debtor_identifier' ? 'IDENTIFIER' : 'TEXT' }
  }
  if (canonicalField.endsWith('_amount')) return { target_entity: 'DEBT', data_type: 'DECIMAL' }
  if (canonicalField.endsWith('_date')) return { target_entity: 'DEBT', data_type: 'DATE' }
  return { target_entity: 'DEBT', data_type: 'TEXT' }
}

async function getImportContext(): Promise<ImportContext | Response> {
  const sessionClient = await createServerSupabaseClient('multi')
  const adminClient = createMultiServerAdminSupabaseClient()
  if (!sessionClient || !adminClient) return jsonError('La integracion Multiinstitucion no esta configurada.', 503)

  const { data, error } = await sessionClient.auth.getUser()
  if (error || !data.user) return jsonError('Sesion requerida.', 401)

  const access = await validateMultiInstitutionAccess(data.user.id, sessionClient)
  if (!access.isAuthorized || !access.context) return jsonError(access.message ?? 'Acceso institucional no autorizado.', 403)
  const institutionId = Number(access.context.institutionId)
  if (!Number.isSafeInteger(institutionId) || institutionId <= 0) {
    return jsonError('No se pudo resolver la institucion activa.', 403)
  }

  const membershipResponse = await adminClient
    .from('institution_membership')
    .select('id')
    .eq('institution_id', institutionId)
    .eq('user_id', data.user.id)
    .eq('status', 'ACTIVE')
    .maybeSingle()
  if (membershipResponse.error || !membershipResponse.data) return jsonError('No existe una membresia institucional activa.', 403)

  const authorizationResponse = await adminClient
    .from('import_authorization')
    .select('active,can_import,can_apply')
    .eq('institution_id', institutionId)
    .eq('membership_id', membershipResponse.data.id)
    .maybeSingle()
  if (authorizationResponse.error) return jsonError('No se pudo validar la autorizacion de importacion.', 503)
  if (!authorizationResponse.data?.active || !authorizationResponse.data.can_import) {
    return jsonError('No tenes permisos para simular importaciones de esta institucion.', 403)
  }

  const controlResponse = await adminClient
    .from('import_control')
    .select('apply_enabled')
    .eq('institution_id', institutionId)
    .maybeSingle()
  if (controlResponse.error) return jsonError('No se pudo validar el control de aplicacion institucional.', 503)

  return {
    adminClient,
    institutionId,
    membershipId: membershipResponse.data.id,
    userId: data.user.id,
    canApply: authorizationResponse.data.can_apply === true
      && controlResponse.data?.apply_enabled === true
      && process.env.MULTI_IMPORT_APPLY_ENABLED === 'true',
  }
}

async function ensureProfileVersion(
  context: ImportContext,
  mapping: MultiImportMapping,
  encoding: 'UTF-8' | 'UTF-8-SIG' | 'WINDOWS-1252',
  delimiter: ',' | ';' | '\t',
) {
  const schemesResponse = await context.adminClient
    .from('import_identity_scheme')
    .select('id,entity_kind,canonical_fields')
    .eq('institution_id', context.institutionId)
    .eq('active', true)
  if (schemesResponse.error) throw new Error(describeSupabaseError('No se pudieron consultar los esquemas de identidad institucionales', schemesResponse.error))
  const schemes = schemesResponse.data ?? []
  const schemeFor = (kind: 'DEBTOR' | 'DEBT' | 'PERSON', required: boolean) => {
    const found = schemes.filter((scheme) => scheme.entity_kind === kind)
    if (required && found.length !== 1) {
      throw new Error(`La institucion debe tener exactamente un esquema de identidad activo para ${kind}.`)
    }
    return found.length === 1 ? found[0] : null
  }
  const debtorScheme = schemeFor('DEBTOR', true)
  const debtScheme = schemeFor('DEBT', true)
  const personIdentityField = mapping.person_external_reference
    ? 'person_external_reference'
    : mapping.person_document_number
      ? 'person_document_number'
      : null
  const personScheme = personIdentityField ? schemeFor('PERSON', true) : null
  if (!debtorScheme || !debtScheme) throw new Error('Faltan esquemas de identidad institucionales.')
  if (
    debtorScheme.canonical_fields.length !== 1 ||
    debtScheme.canonical_fields.length !== 1 ||
    (personScheme && personScheme.canonical_fields.length !== 1)
  ) {
    throw new Error('El importador genérico actual requiere una única clave estable por entidad. Configurá un esquema de identidad de un solo campo para esta institución.')
  }

  let profileResponse = await context.adminClient
    .from('import_profile')
    .select('id')
    .eq('institution_id', context.institutionId)
    .eq('code', PROFILE_CODE)
    .maybeSingle()
  if (profileResponse.error) throw new Error(describeSupabaseError('No se pudo consultar el perfil de importacion', profileResponse.error))
  if (!profileResponse.data) {
    profileResponse = await context.adminClient
      .from('import_profile')
      .insert({ institution_id: context.institutionId, code: PROFILE_CODE, display_name: 'CSV institucional', status: 'DRAFT' })
      .select('id')
      .single()
    if (profileResponse.error || !profileResponse.data) throw new Error(describeSupabaseError('No se pudo crear el perfil de importacion institucional', profileResponse.error))
  }
  const profileId = profileResponse.data.id as number

  const versionsResponse = await context.adminClient
    .from('import_profile_version')
    .select('id,version_number,status,delimiter,encoding,debtor_identity_scheme_id,debt_identity_scheme_id,person_identity_scheme_id')
    .eq('institution_id', context.institutionId)
    .eq('profile_id', profileId)
    .order('version_number', { ascending: false })
  if (versionsResponse.error) throw new Error(describeSupabaseError('No se pudieron consultar las versiones del perfil', versionsResponse.error))
  const activeVersion = (versionsResponse.data ?? []).find((version) => version.status === 'ACTIVE')
  if (activeVersion) {
    const mappingsResponse = await context.adminClient
      .from('import_field_mapping')
      .select('canonical_field,source_headers')
      .eq('profile_version_id', activeVersion.id)
      .eq('active', true)
    const savedMapping = Object.fromEntries(
      (mappingsResponse.data ?? []).map((row) => [row.canonical_field, row.source_headers?.[0]])
    )
    if (mappingsResponse.error) throw new Error(describeSupabaseError('No se pudo consultar el mapeo institucional guardado', mappingsResponse.error))
    if (
      mappingSignature(savedMapping) === mappingSignature(mapping) &&
      activeVersion.encoding === encoding &&
      activeVersion.delimiter === delimiter &&
      activeVersion.debtor_identity_scheme_id === debtorScheme.id &&
      activeVersion.debt_identity_scheme_id === debtScheme.id &&
      activeVersion.person_identity_scheme_id === (personScheme?.id ?? null)
    ) {
      return {
        id: activeVersion.id as number,
        mapping,
        identityFields: {
          debtor: debtorScheme.canonical_fields,
          debt: debtScheme.canonical_fields,
          person: personScheme?.canonical_fields ?? [],
        },
        identityValueFields: {
          debtor: 'debtor_external_reference',
          debt: 'debt_external_reference',
          person: personIdentityField,
        },
        identitySchemeIds: {
          debtor: debtorScheme.id as number,
          debt: debtScheme.id as number,
          person: personScheme ? Number(personScheme.id) : null,
        } satisfies IdentitySchemeSnapshot,
      }
    }
  }

  const nextVersion = Math.max(0, ...(versionsResponse.data ?? []).map((version) => version.version_number as number)) + 1
  const createdVersion = await context.adminClient
    .from('import_profile_version')
    .insert({
      institution_id: context.institutionId,
      profile_id: profileId,
      version_number: nextVersion,
      status: 'DRAFT',
      delimiter,
      encoding,
      debtor_identity_scheme_id: debtorScheme.id,
      debt_identity_scheme_id: debtScheme.id,
      person_identity_scheme_id: personScheme?.id ?? null,
    })
    .select('id')
    .single()
  if (createdVersion.error || !createdVersion.data) throw new Error(describeSupabaseError('No se pudo crear una version de perfil para el CSV', createdVersion.error))

  const fieldMappings = Object.entries(mapping).map(([canonicalField, sourceHeader]) => {
    const metadata = importFieldMetadata(canonicalField)
    return {
      profile_version_id: createdVersion.data.id,
      canonical_field: canonicalField,
      target_entity: metadata.target_entity,
      source_headers: [sourceHeader],
      data_type: metadata.data_type,
      required_on_insert: ['debtor_external_reference', 'debt_external_reference', 'original_amount', 'current_amount'].includes(canonicalField),
      required_on_update: ['debtor_external_reference', 'debt_external_reference'].includes(canonicalField),
    }
  })
  const mappingResponse = await context.adminClient.from('import_field_mapping').insert(fieldMappings)
  if (mappingResponse.error) {
    await context.adminClient
      .from('import_profile_version')
      .delete()
      .eq('id', createdVersion.data.id)
      .eq('institution_id', context.institutionId)
      .eq('status', 'DRAFT')
    throw new Error(describeSupabaseError('No se pudo guardar el mapeo institucional del CSV', mappingResponse.error))
  }

  if (activeVersion) {
    const retireResponse = await context.adminClient
      .from('import_profile_version')
      .update({ status: 'RETIRED' })
      .eq('id', activeVersion.id)
    if (retireResponse.error) throw new Error(describeSupabaseError('No se pudo archivar la version anterior del perfil', retireResponse.error))
  }
  const activateResponse = await context.adminClient
    .from('import_profile_version')
    .update({ status: 'ACTIVE', activated_at: new Date().toISOString() })
    .eq('id', createdVersion.data.id)
  if (activateResponse.error) throw new Error(describeSupabaseError('No se pudo activar el perfil de importacion', activateResponse.error))
  const profileActivation = await context.adminClient
    .from('import_profile')
    .update({ status: 'ACTIVE', updated_at: new Date().toISOString() })
    .eq('id', profileId)
  if (profileActivation.error) throw new Error(describeSupabaseError('No se pudo activar el perfil institucional', profileActivation.error))

  return {
    id: createdVersion.data.id as number,
    mapping,
    identityFields: {
      debtor: debtorScheme.canonical_fields,
      debt: debtScheme.canonical_fields,
      person: personScheme?.canonical_fields ?? [],
    },
    identityValueFields: {
      debtor: 'debtor_external_reference',
      debt: 'debt_external_reference',
      person: personIdentityField,
    },
    identitySchemeIds: {
      debtor: debtorScheme.id as number,
      debt: debtScheme.id as number,
      person: personScheme ? Number(personScheme.id) : null,
    } satisfies IdentitySchemeSnapshot,
  }
}

export async function GET(request: Request) {
  const context = await getImportContext()
  if (context instanceof Response) return context
  const jobId = Number(new URL(request.url).searchParams.get('jobId'))
  const fields = 'id,file_name,file_size_bytes,mode,status,simulation_job_id,total_rows,processed_rows,inserted_rows,updated_rows,unchanged_rows,rejected_rows,ignored_columns,dry_run_summary,error_message,created_at,completed_at,merge_completed_at,profiles_recalculated_at,profile_recalculation_error'
  const jobsQuery = context.adminClient.from('import_job').select(fields).eq('institution_id', context.institutionId)
  if (!Number.isSafeInteger(jobId) || jobId <= 0) {
    const response = await jobsQuery.order('created_at', { ascending: false }).limit(20)
    if (response.error) return jsonError('No se pudo consultar el historial de simulaciones.', 500)
    return Response.json({ jobs: response.data ?? [], capabilities: { canApply: context.canApply } }, { headers: { 'Cache-Control': 'no-store' } })
  }
  const jobResponse = await jobsQuery.eq('id', jobId).maybeSingle()
  if (jobResponse.error || !jobResponse.data) return jsonError('La simulacion solicitada no existe.', 404)
  const [errorsResponse, stageResponse] = await Promise.all([
    context.adminClient.from('import_row_error').select('source_row,code,message,source_key').eq('job_id', jobId).order('source_row').limit(200),
    context.adminClient.from('import_stage_row').select('source_row,normalized_values,validation_status').eq('job_id', jobId).order('source_row').limit(25),
  ])
  if (errorsResponse.error || stageResponse.error) return jsonError('No se pudo consultar el detalle de la simulacion.', 500)
  return Response.json({ job: jobResponse.data, errors: errorsResponse.data ?? [], preview: stageResponse.data ?? [], capabilities: { canApply: context.canApply } }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: Request) {
  const context = await getImportContext()
  if (context instanceof Response) return context
  let payload: Record<string, unknown>
  try { payload = await request.json() as Record<string, unknown> } catch { return jsonError('El cuerpo de la solicitud no es valido.', 400) }

  if (payload.action === 'queue' || payload.action === 'retry' || payload.action === 'retry_profiles') {
    const jobId = Number(payload.jobId)
    if (!Number.isSafeInteger(jobId) || jobId <= 0) return jsonError('La simulacion indicada no es valida.', 400)
    const allowedStatus = payload.action === 'queue' ? 'UPLOADING' : payload.action === 'retry_profiles' ? 'RECALCULATING_PROFILES' : 'FAILED'
    const retryPayload = payload.action === 'retry_profiles'
      ? { status: 'QUEUED', error_message: null, profile_recalculation_error: null, completed_at: null }
      : {
          status: 'QUEUED',
          error_message: null,
          processed_rows: 0,
          inserted_rows: 0,
          updated_rows: 0,
          unchanged_rows: 0,
          rejected_rows: 0,
          completed_at: null,
        }
    const response = await context.adminClient
      .from('import_job')
      .update(retryPayload)
      .eq('id', jobId)
      .eq('institution_id', context.institutionId)
      .eq('requested_by', context.userId)
      .eq('status', allowedStatus)
      .select('id,file_name,file_size_bytes,mode,status,simulation_job_id,total_rows,processed_rows,inserted_rows,updated_rows,unchanged_rows,rejected_rows,ignored_columns,dry_run_summary,error_message,created_at,completed_at,merge_completed_at,profiles_recalculated_at,profile_recalculation_error')
      .maybeSingle()
    if (response.error || !response.data) return jsonError('La importacion no se puede encolar en su estado actual.', 409)
    // Un fallo de GitHub no cambia el estado QUEUED: el cron de respaldo
    // puede reclamar el trabajo posteriormente sin duplicar operaciones.
    const dispatch = await dispatchMultiInstitutionCsvImport(response.data.id)
    return Response.json({ job: response.data, dispatch })
  }

  if (payload.action === 'apply') {
    if (!context.canApply) return jsonError('La actualizacion real permanece bloqueada para esta institucion.', 403)
    const sourceJobId = Number(payload.jobId)
    if (!Number.isSafeInteger(sourceJobId) || sourceJobId <= 0) return jsonError('La simulacion indicada no es valida.', 400)
    const source = await context.adminClient
      .from('import_job')
      .select('id,institution_id,requested_by,profile_version_id,file_name,file_size_bytes,content_sha256,profile_snapshot,status,mode,rejected_rows,total_rows,processed_rows,inserted_rows,updated_rows,unchanged_rows,ignored_columns,dry_run_summary')
      .eq('id', sourceJobId)
      .eq('institution_id', context.institutionId)
      .eq('requested_by', context.userId)
      .maybeSingle()
    if (source.error || !source.data || source.data.mode !== 'DRY_RUN' || source.data.status !== 'DRY_RUN_COMPLETED' || source.data.rejected_rows !== 0) {
      return jsonError('Solo se puede aplicar una simulacion terminada sin filas rechazadas.', 409)
    }
    const created = await context.adminClient
      .from('import_job')
      .insert({
        institution_id: context.institutionId,
        requested_by: context.userId,
        profile_version_id: source.data.profile_version_id,
        file_name: source.data.file_name,
        storage_path: null,
        content_sha256: source.data.content_sha256,
        file_size_bytes: source.data.file_size_bytes,
        mode: 'APPLY',
        status: 'QUEUED',
        simulation_job_id: source.data.id,
        apply_confirmed_by: context.userId,
        apply_confirmed_at: new Date().toISOString(),
        profile_snapshot: source.data.profile_snapshot,
        total_rows: source.data.total_rows,
        processed_rows: source.data.processed_rows,
        inserted_rows: source.data.inserted_rows,
        updated_rows: source.data.updated_rows,
        unchanged_rows: source.data.unchanged_rows,
        rejected_rows: 0,
        ignored_columns: source.data.ignored_columns,
        dry_run_summary: source.data.dry_run_summary,
      })
      .select('id,file_name,file_size_bytes,mode,status,simulation_job_id,total_rows,processed_rows,inserted_rows,updated_rows,unchanged_rows,rejected_rows,ignored_columns,dry_run_summary,error_message,created_at,completed_at,merge_completed_at,profiles_recalculated_at,profile_recalculation_error')
      .single()
    if (created.error || !created.data) return jsonError(describeSupabaseError('No se pudo registrar la actualizacion real', created.error), 500)
    const dispatch = await dispatchMultiInstitutionCsvImport(created.data.id)
    return Response.json({ job: created.data, dispatch })
  }

  if (payload.action !== 'create') return jsonError('La accion solicitada no es valida.', 400)
  const fileName = typeof payload.fileName === 'string' ? payload.fileName.trim() : ''
  const fileSize = Number(payload.fileSize)
  const headers = payload.headers
  const mapping = normalizeMapping(payload.mapping, headers)
  if (!fileName.toLowerCase().endsWith('.csv')) return jsonError('Solo se permiten archivos CSV.', 400)
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || fileSize > MULTI_IMPORT_MAX_FILE_SIZE) return jsonError('El archivo debe tener un tamaño entre 1 byte y 100 MB.', 400)
  if (!isSha256(payload.contentHash)) return jsonError('No se pudo validar la huella SHA-256 del archivo.', 400)
  if (!mapping) return jsonError('Revisa el mapeo: faltan identificadores requeridos o hay columnas repetidas.', 400)
  if (!isProfileEncoding(payload.encoding) || !isDelimiter(payload.delimiter)) return jsonError('No se pudo validar el formato detectado del CSV.', 400)

  try {
    const profile = await ensureProfileVersion(context, mapping, payload.encoding, payload.delimiter)
    const existing = await context.adminClient
      .from('import_job')
      .select('id,file_name,file_size_bytes,mode,status,total_rows,processed_rows,inserted_rows,updated_rows,unchanged_rows,rejected_rows,ignored_columns,dry_run_summary,error_message,created_at,completed_at')
      .eq('institution_id', context.institutionId)
      .eq('content_sha256', payload.contentHash)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (existing.error) throw new Error('No se pudo consultar el historial del archivo.')
    if (existing.data && payload.forceNewDryRun !== true) return Response.json({ job: existing.data, reused: true })

    const safeName = sanitizeFileName(fileName)
    const pathHash = createHash('sha256').update(`${context.institutionId}:${payload.contentHash}:${safeName}`).digest('hex').slice(0, 16)
    const storagePath = `institution-${context.institutionId}/${Date.now()}-${pathHash}-${safeName}`
    const created = await context.adminClient
      .from('import_job')
      .insert({
        institution_id: context.institutionId,
        requested_by: context.userId,
        profile_version_id: profile.id,
        file_name: safeName,
        storage_path: storagePath,
        content_sha256: payload.contentHash,
        file_size_bytes: fileSize,
        mode: 'DRY_RUN',
        status: 'UPLOADING',
        profile_snapshot: {
          mapping: profile.mapping,
          identity_fields: profile.identityFields,
          identity_value_fields: profile.identityValueFields,
          identity_scheme_ids: profile.identitySchemeIds,
        },
      })
      .select('id,file_name,file_size_bytes,mode,status,total_rows,processed_rows,inserted_rows,updated_rows,unchanged_rows,rejected_rows,ignored_columns,dry_run_summary,error_message,created_at,completed_at')
      .single()
    if (created.error || !created.data) throw new Error('No se pudo registrar la simulacion institucional.')
    const upload = await context.adminClient.storage.from(MULTI_IMPORT_BUCKET).createSignedUploadUrl(storagePath, { upsert: false })
    if (upload.error || !upload.data) {
      await context.adminClient.from('import_job').update({ status: 'FAILED', error_message: 'No se pudo preparar la carga privada del archivo.' }).eq('id', created.data.id)
      throw new Error('No se pudo preparar la carga privada del archivo.')
    }
    return Response.json({ job: created.data, upload: { bucket: MULTI_IMPORT_BUCKET, path: storagePath, token: upload.data.token } })
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'No se pudo iniciar la simulacion.', 500)
  }
}
