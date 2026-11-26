import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  responses: new Map<string, Array<{ data: unknown; error: unknown }>>(),
  signedUpload: { data: { token: 'signed-upload-token' }, error: null as unknown },
}))

function next(table: string) {
  return state.responses.get(table)?.shift() ?? { data: null, error: null }
}

class Query {
  constructor(private readonly table: string) {}
  select(value: string) { void value; return this }
  eq(column: string, value: unknown) { void column; void value; return this }
  order(column: string, options?: unknown) { void column; void options; return this }
  limit(value: number) { void value; return this }
  maybeSingle() { return Promise.resolve(next(this.table)) }
  single() { return Promise.resolve(next(this.table)) }
  update(value: unknown) { void value; return this }
  insert(value: unknown) { void value; return this }
  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) { return Promise.resolve(next(this.table)).then(onfulfilled, onrejected) }
}

const admin = {
  from: (table: string) => new Query(table),
  storage: { from: vi.fn(() => ({ createSignedUploadUrl: vi.fn(async () => state.signedUpload) })) },
}

vi.mock('@/lib/imports', () => ({
  getLafaldaImportTenantId: () => 1,
  isLafaldaApplyEnabled: () => false,
  isImportMode: (value: unknown) => value === 'dry_run' || value === 'apply',
  canUseImportMode: (authorization: { active: boolean; canImport: boolean; canApply: boolean } | null, mode: string) => Boolean(authorization?.active && authorization.canImport && (mode !== 'apply' || authorization.canApply)),
  LAFALDA_IMPORT_BUCKET: 'lafalda-imports', LAFALDA_IMPORT_ERROR_TABLE: 'data_import_row_error', LAFALDA_IMPORT_JOB_TABLE: 'data_import_job',
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'auth-1' } }, error: null })) } })),
  createServerAdminSupabaseClient: vi.fn(() => admin),
}))
vi.mock('@/lib/services/auth-service', () => ({
  validateAuthUserTenantAccess: vi.fn(async () => ({ isAuthorized: true, context: { tenantId: '1', appUserId: '2' } })),
}))
vi.mock('@/lib/github-import-dispatcher', () => ({
  dispatchLafaldaCsvImport: vi.fn(async () => ({ status: 'dispatched' })),
  shouldDispatchImportWorkflow: vi.fn(() => true),
}))

import { GET, POST } from '@/app/api/imports/route'

function setContext() {
  state.responses.set('data_import_authorization', [{ data: { active: true, can_import: true, can_apply: false }, error: null }])
}

beforeEach(() => {
  state.responses.clear()
  state.signedUpload = { data: { token: 'signed-upload-token' }, error: null }
  vi.clearAllMocks()
})

describe('API de importaciones de La Falda', () => {
  it('lista solo el historial autorizado del tenant configurado', async () => {
    setContext()
    state.responses.set('data_import_job', [{ data: [{ id: 10, status: 'DRY_RUN_COMPLETED' }], error: null }])

    const response = (await GET(new Request('http://localhost/api/imports')))!

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ jobs: [{ id: 10, status: 'DRY_RUN_COMPLETED' }] })
  })

  it('no permite solicitar APPLY cuando el control del entorno estÃ¡ apagado', async () => {
    setContext()

    const response = (await POST(new Request('http://localhost/api/imports', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        action: 'create', fileName: 'actualizacion.csv', fileSize: 10, contentHash: 'a'.repeat(64), mode: 'apply',
      }),
    })))!

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'Las importaciones confirmadas no estan habilitadas.' })
  })

  it('crea una simulacion nueva y prepara la carga privada del CSV', async () => {
    setContext()
    state.responses.set('data_import_job', [
      { data: null, error: null },
      { data: { id: 22, file_name: 'deudas.csv', mode: 'dry_run', status: 'UPLOADING' }, error: null },
    ])

    const response = (await POST(new Request('http://localhost/api/imports', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        action: 'create', fileName: 'deudas.csv', fileSize: 42, contentHash: 'b'.repeat(64), mode: 'dry_run',
      }),
    })))!

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      job: { id: 22, status: 'UPLOADING' },
      upload: { bucket: 'lafalda-imports', token: 'signed-upload-token' },
    })
  })

  it('encola una carga ya subida y despacha el worker sin cambiar el modo', async () => {
    setContext()
    state.responses.set('data_import_job', [
      { data: { id: 23, status: 'UPLOADING', mode: 'dry_run' }, error: null },
      { data: { id: 23, status: 'QUEUED', mode: 'dry_run' }, error: null },
    ])

    const response = (await POST(new Request('http://localhost/api/imports', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'queue', jobId: 23 }),
    })))!

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ job: { id: 23, status: 'QUEUED' }, dispatch: { status: 'dispatched' } })
  })

  it('muestra el detalle y los errores del trabajo seleccionado', async () => {
    setContext()
    state.responses.set('data_import_job', [{ data: { id: 24, status: 'FAILED' }, error: null }])
    state.responses.set('data_import_row_error', [{ data: [{ source_row: 4, code: 'INVALID_DATE', message: 'Fecha invalida' }], error: null }])

    const response = (await GET(new Request('http://localhost/api/imports?jobId=24')))!

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      job: { id: 24, status: 'FAILED' },
      errors: [{ source_row: 4, code: 'INVALID_DATE', message: 'Fecha invalida' }],
    })
  })

  it('reutiliza una simulacion previa del mismo archivo sin crear un trabajo duplicado', async () => {
    setContext()
    state.responses.set('data_import_job', [{
      data: { id: 25, file_name: 'ya-procesado.csv', mode: 'dry_run', status: 'DRY_RUN_COMPLETED' }, error: null,
    }])

    const response = (await POST(new Request('http://localhost/api/imports', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        action: 'create', fileName: 'ya-procesado.csv', fileSize: 42, contentHash: 'c'.repeat(64), mode: 'dry_run',
      }),
    })))!

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      job: { id: 25, file_name: 'ya-procesado.csv', mode: 'dry_run', status: 'DRY_RUN_COMPLETED' }, reused: true,
    })
  })

  it('rechaza metadatos de archivo invalidos antes de crear una importacion', async () => {
    setContext()

    const response = (await POST(new Request('http://localhost/api/imports', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        action: 'create', fileName: 'deudas.xlsx', fileSize: 0, contentHash: 'invalido', mode: 'dry_run',
      }),
    })))!

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Solo se permiten archivos CSV.' })
  })
})
