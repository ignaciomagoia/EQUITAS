import { beforeEach, describe, expect, it, vi } from 'vitest'

type ResponseData = { data?: unknown; error?: unknown }

const state = vi.hoisted(() => ({
  responses: new Map<string, ResponseData[]>(),
  calls: [] as Array<{ table: string; action: string; payload?: unknown }>,
  access: {
    isAuthorized: true,
    requiresLogin: false,
    context: {
      authUserId: 'user-1', appUserId: 'user-1', institutionId: '7', institutionName: 'Universidad Demo',
      institutionSlug: 'universidad-demo', tenantId: '7', role: 'institution_admin',
    },
  },
  dispatch: { status: 'dispatched' as 'dispatched' | 'failed' },
  signedUpload: { data: { token: 'signed-upload-token' }, error: null as unknown },
}))

function nextResponse(table: string): ResponseData {
  return state.responses.get(table)?.shift() ?? { data: null, error: null }
}

class Query {
  constructor(private readonly table: string) {}

  select(columns: string) { void columns; state.calls.push({ table: this.table, action: 'select' }); return this }
  eq(column: string, value: unknown) { void column; void value; return this }
  order(column: string, options?: unknown) { void column; void options; return this }
  limit(value: number) { void value; return this }
  maybeSingle() { return Promise.resolve(nextResponse(this.table)) }
  single() { return Promise.resolve(nextResponse(this.table)) }
  insert(payload: unknown) { state.calls.push({ table: this.table, action: 'insert', payload }); return this }
  update(payload: unknown) { state.calls.push({ table: this.table, action: 'update', payload }); return this }
  delete() { state.calls.push({ table: this.table, action: 'delete' }); return this }
  then<TResult1 = ResponseData, TResult2 = never>(
    onfulfilled?: ((value: ResponseData) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return Promise.resolve(nextResponse(this.table)).then(onfulfilled, onrejected)
  }
}

const adminClient = {
  from(table: string) { return new Query(table) },
  storage: { from: vi.fn(() => ({ createSignedUploadUrl: vi.fn(async () => state.signedUpload) })) },
}

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })) } })),
  createMultiServerAdminSupabaseClient: vi.fn(() => adminClient),
}))

vi.mock('@/lib/services/multi-auth-service', () => ({
  validateMultiInstitutionAccess: vi.fn(async () => state.access),
}))

vi.mock('@/lib/github-multi-import-dispatcher', () => ({
  dispatchMultiInstitutionCsvImport: vi.fn(async () => state.dispatch),
}))

import { GET, POST } from '@/app/api/multi-imports/route'

function setContextResponses() {
  state.responses.set('institution_membership', [{ data: { id: 31 }, error: null }])
  state.responses.set('import_authorization', [{ data: { active: true, can_import: true, can_apply: false }, error: null }])
  state.responses.set('import_control', [{ data: { apply_enabled: false }, error: null }])
}

beforeEach(() => {
  state.responses.clear()
  state.calls.length = 0
  state.access = {
    isAuthorized: true,
    requiresLogin: false,
    context: {
      authUserId: 'user-1', appUserId: 'user-1', institutionId: '7', institutionName: 'Universidad Demo',
      institutionSlug: 'universidad-demo', tenantId: '7', role: 'institution_admin',
    },
  }
  state.dispatch = { status: 'dispatched' }
  state.signedUpload = { data: { token: 'signed-upload-token' }, error: null }
  vi.unstubAllEnvs()
})

describe('API de importaciones MultiinstituciÃ³n', () => {
  it('devuelve solo el historial de la instituciÃ³n autorizada', async () => {
    setContextResponses()
    state.responses.set('import_job', [{ data: [{ id: 91, status: 'DRY_RUN_COMPLETED' }], error: null }])

    const response = await GET(new Request('http://localhost/api/multi-imports'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      jobs: [{ id: 91, status: 'DRY_RUN_COMPLETED' }],
      capabilities: { canApply: false },
    })
    expect(state.calls.filter((call) => call.table === 'import_job')).toHaveLength(1)
  })

  it('rechaza un cuerpo invÃ¡lido antes de crear trabajos o archivos', async () => {
    setContextResponses()

    const response = await POST(new Request('http://localhost/api/multi-imports', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create' }),
    }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Solo se permiten archivos CSV.' })
    expect(state.calls.some((call) => call.action === 'insert')).toBe(false)
  })

  it('mantiene APPLY bloqueado cuando falla cualquiera de sus controles institucionales', async () => {
    setContextResponses()

    const response = await POST(new Request('http://localhost/api/multi-imports', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'apply', jobId: 91 }),
    }))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'La actualizacion real permanece bloqueada para esta institucion.' })
    expect(state.calls.some((call) => call.table === 'import_job' && call.action === 'insert')).toBe(false)
  })

  it('encola un archivo ya cargado y conserva el trabajo aunque el despacho externo falle', async () => {
    setContextResponses()
    state.responses.set('import_job', [{ data: { id: 91, status: 'QUEUED', mode: 'DRY_RUN' }, error: null }])
    state.dispatch = { status: 'failed' }

    const response = await POST(new Request('http://localhost/api/multi-imports', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'queue', jobId: 91 }),
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      job: { id: 91, status: 'QUEUED', mode: 'DRY_RUN' }, dispatch: { status: 'failed' },
    })
    expect(state.calls).toContainEqual(expect.objectContaining({ table: 'import_job', action: 'update' }))
  })

  it('reutiliza un perfil compatible y un dry-run previo sin crear una segunda carga', async () => {
    setContextResponses()
    state.responses.set('import_identity_scheme', [{
      data: [
        { id: 11, entity_kind: 'DEBTOR', canonical_fields: ['debtor_external_reference'] },
        { id: 12, entity_kind: 'DEBT', canonical_fields: ['debt_external_reference'] },
      ], error: null,
    }])
    state.responses.set('import_profile', [{ data: { id: 21 }, error: null }])
    state.responses.set('import_profile_version', [{
      data: [{
        id: 31, version_number: 1, status: 'ACTIVE', delimiter: ',', encoding: 'UTF-8',
        debtor_identity_scheme_id: 11, debt_identity_scheme_id: 12, person_identity_scheme_id: null,
      }], error: null,
    }])
    state.responses.set('import_field_mapping', [{ data: [
      { canonical_field: 'debtor_external_reference', source_headers: ['Cuenta'] },
      { canonical_field: 'debt_external_reference', source_headers: ['Deuda'] },
      { canonical_field: 'current_amount', source_headers: ['Saldo'] },
    ], error: null }])
    state.responses.set('import_job', [{ data: { id: 44, file_name: 'previo.csv', mode: 'DRY_RUN', status: 'DRY_RUN_COMPLETED' }, error: null }])

    const response = await POST(new Request('http://localhost/api/multi-imports', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        action: 'create', fileName: 'universidad.csv', fileSize: 120,
        contentHash: 'a'.repeat(64), headers: ['Cuenta', 'Deuda', 'Saldo'],
        mapping: { debtor_external_reference: 'Cuenta', debt_external_reference: 'Deuda', current_amount: 'Saldo' },
        encoding: 'UTF-8', delimiter: ',',
      }),
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      job: { id: 44, file_name: 'previo.csv', mode: 'DRY_RUN', status: 'DRY_RUN_COMPLETED' }, reused: true,
    })
    expect(state.calls.some((call) => call.table === 'import_profile_version' && call.action === 'insert')).toBe(false)
    expect(state.calls.some((call) => call.table === 'import_job' && call.action === 'insert')).toBe(false)
  })

  it('crea un trabajo APPLY solamente desde una simulacion validada y autorizada', async () => {
    state.responses.set('institution_membership', [{ data: { id: 31 }, error: null }])
    state.responses.set('import_authorization', [{ data: { active: true, can_import: true, can_apply: true }, error: null }])
    state.responses.set('import_control', [{ data: { apply_enabled: true }, error: null }])
    state.responses.set('import_job', [
      {
        data: {
          id: 81, institution_id: 7, requested_by: 'user-1', profile_version_id: 21,
          file_name: 'universidad.csv', file_size_bytes: 120, content_sha256: 'a'.repeat(64), profile_snapshot: {},
          status: 'DRY_RUN_COMPLETED', mode: 'DRY_RUN', rejected_rows: 0, total_rows: 2, processed_rows: 2,
          inserted_rows: 1, updated_rows: 0, unchanged_rows: 1, ignored_columns: [], dry_run_summary: {},
        }, error: null,
      },
      { data: { id: 82, mode: 'APPLY', status: 'QUEUED', simulation_job_id: 81 }, error: null },
    ])
    vi.stubEnv('MULTI_IMPORT_APPLY_ENABLED', 'true')

    const response = (await POST(new Request('http://localhost/api/multi-imports', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'apply', jobId: 81 }),
    })))!

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      job: { id: 82, mode: 'APPLY', simulation_job_id: 81 }, dispatch: { status: 'dispatched' },
    })
    expect(state.calls).toContainEqual(expect.objectContaining({ table: 'import_job', action: 'insert' }))
  })

  it('crea y activa un perfil institucional para un formato CSV nuevo', async () => {
    setContextResponses()
    state.responses.set('import_identity_scheme', [{
      data: [
        { id: 11, entity_kind: 'DEBTOR', canonical_fields: ['debtor_external_reference'] },
        { id: 12, entity_kind: 'DEBT', canonical_fields: ['debt_external_reference'] },
      ], error: null,
    }])
    state.responses.set('import_profile', [
      { data: null, error: null },
      { data: { id: 21 }, error: null },
      { data: null, error: null },
    ])
    state.responses.set('import_profile_version', [
      { data: [], error: null },
      { data: { id: 32 }, error: null },
      { data: null, error: null },
    ])
    state.responses.set('import_field_mapping', [{ data: null, error: null }])
    state.responses.set('import_job', [
      { data: null, error: null },
      { data: { id: 83, mode: 'DRY_RUN', status: 'UPLOADING' }, error: null },
    ])

    const response = (await POST(new Request('http://localhost/api/multi-imports', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        action: 'create', fileName: 'universidad-nuevo.csv', fileSize: 120, contentHash: 'd'.repeat(64),
        headers: ['Cuenta', 'Deuda', 'Saldo'],
        mapping: { debtor_external_reference: 'Cuenta', debt_external_reference: 'Deuda', current_amount: 'Saldo' },
        encoding: 'UTF-8', delimiter: ',',
      }),
    })))!

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ job: { id: 83, status: 'UPLOADING' }, upload: { token: 'signed-upload-token' } })
    expect(state.calls.filter((call) => call.table === 'import_profile_version' && call.action === 'insert')).toHaveLength(1)
    expect(state.calls.filter((call) => call.table === 'import_field_mapping' && call.action === 'insert')).toHaveLength(1)
  })
})
