import type { ReactElement, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  values: [] as unknown[],
  setters: [] as Array<ReturnType<typeof vi.fn>>,
  upload: vi.fn(async () => ({ error: null })),
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: <T,>(initial: T) => {
      const value = (state.values.length ? state.values.shift() : initial) as T
      const setter = vi.fn()
      state.setters.push(setter)
      return [value, setter] as const
    },
    useEffect: () => undefined,
    useMemo: <T,>(factory: () => T) => factory(),
    useCallback: <T extends (...arguments_: never[]) => unknown>(callback: T) => callback,
    useRef: <T,>(value: T) => ({ current: value }),
  }
})

vi.mock('@/lib/supabase-browser', () => ({
  createBrowserSupabaseClient: vi.fn(() => ({ storage: { from: () => ({ uploadToSignedUrl: state.upload }) } })),
}))

import { MultiImportPanel } from '@/components/imports/multi-import-panel'

type TestElement = ReactElement<{ children?: ReactNode }>

function findElement(node: ReactNode, predicate: (element: TestElement) => boolean): TestElement | undefined {
  if (!node || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate)
      if (found) return found
    }
    return undefined
  }
  const element = node as TestElement
  if (predicate(element)) return element
  return findElement(element.props.children, predicate)
}

function prepareState() {
  const file = new File(['Cuenta,Deuda\nUNI-1,D-1\n'], 'universidad.csv', { type: 'text/csv' })
  state.values = [
    file,
    {
      encoding: 'UTF-8', delimiter: ',', headers: ['Cuenta', 'Deuda'],
      mapping: { debtor_external_reference: 'Cuenta', debt_external_reference: 'Deuda' },
      ignoredColumns: [], missingRequiredFields: [], ambiguousFields: {},
    },
    { debtor_external_reference: 'Cuenta', debt_external_reference: 'Deuda' },
    [], null, null, false, false, false, false, null, null, true,
  ]
  state.setters = []
  state.upload.mockClear()
}

function textContent(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(textContent).join('')
  if (value && typeof value === 'object') {
    return textContent((value as ReactElement<{ children?: ReactNode }>).props.children)
  }
  return ''
}

describe('flujo de simulaciÃ³n del panel MultiinstituciÃ³n', () => {
  beforeEach(() => {
    prepareState()
    vi.stubGlobal('crypto', { subtle: { digest: vi.fn(async () => new Uint8Array(32).buffer) } })
  })

  it('crea, carga en Storage privado y encola el trabajo sin ejecutar APPLY', async () => {
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        job: { id: 61 }, upload: { bucket: 'equitas-multi-imports', path: 'institution-7/source.csv', token: 'short-lived' },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ job: { id: 61 }, dispatch: { status: 'dispatched' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchImplementation)

    const tree = MultiImportPanel()
    const form = findElement(tree, (element) => element.type === 'form')
    expect(form).toBeDefined()

    await (form!.props as { onSubmit: (event: { preventDefault(): void }) => Promise<void> }).onSubmit({ preventDefault: vi.fn() })

    expect(fetchImplementation).toHaveBeenNthCalledWith(1, '/api/multi-imports', expect.objectContaining({ method: 'POST' }))
    const firstPayload = JSON.parse(fetchImplementation.mock.calls[0][1].body)
    expect(firstPayload).toMatchObject({ action: 'create', fileName: 'universidad.csv', encoding: 'UTF-8', delimiter: ',' })
    expect(state.upload).toHaveBeenCalledWith('institution-7/source.csv', 'short-lived', expect.any(File), { contentType: 'text/csv' })
    const queuedPayload = JSON.parse(fetchImplementation.mock.calls[1][1].body)
    expect(queuedPayload).toEqual({ action: 'queue', jobId: 61 })
    expect(fetchImplementation.mock.calls.every((call) => !String(call[1]?.body).includes('apply'))).toBe(true)
  })

  it('confirma APPLY desde una simulacion validada y refresca su resultado', async () => {
    state.values = [
      null, null, {}, [], 61,
      {
        job: {
          id: 61, mode: 'DRY_RUN', status: 'DRY_RUN_COMPLETED', rejected_rows: 0,
          inserted_rows: 0, updated_rows: 1, unchanged_rows: 1, ignored_columns: [],
          dry_run_summary: {}, processed_rows: 2, total_rows: 2, file_name: 'universidad.csv',
          file_size_bytes: 24, created_at: '2026-11-26T00:00:00.000Z',
        },
        errors: [], preview: [],
      },
      false, false, false, false, null, null, true,
    ]
    state.setters = []
    vi.stubGlobal('window', { confirm: vi.fn(() => true) })
    const appliedJob = {
      id: 62, mode: 'APPLY', status: 'QUEUED', rejected_rows: 0,
      inserted_rows: 0, updated_rows: 1, unchanged_rows: 1, ignored_columns: [],
      dry_run_summary: {}, processed_rows: 0, total_rows: 2, file_name: 'universidad.csv',
      file_size_bytes: 24, created_at: '2026-11-26T00:00:00.000Z',
    }
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ job: appliedJob, dispatch: { status: 'dispatched' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ job: appliedJob, errors: [], preview: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: [appliedJob], capabilities: { canApply: true } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ job: appliedJob, errors: [], preview: [] }), { status: 200 })))

    const tree = MultiImportPanel()
    const applyButton = findElement(tree, (element) => textContent(element.props.children) === 'Actualizar deudas')
    expect(applyButton).toBeDefined()

    ;(applyButton!.props as { onClick(): void }).onClick()
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(4))

    expect(window.confirm).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/multi-imports', expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toEqual({ action: 'apply', jobId: 61 })
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('/api/multi-imports?jobId=62', { cache: 'no-store' })
  })

  it('detiene una carga sin archivo o sin identificadores obligatorios', async () => {
    state.values = [null, null, {}, [], null, null, false, false, false, false, null, null, false]
    state.setters = []
    let tree = MultiImportPanel()
    let form = findElement(tree, (element) => element.type === 'form')
    await (form!.props as { onSubmit(event: { preventDefault(): void }): Promise<void> }).onSubmit({ preventDefault: vi.fn() })
    expect(state.setters.some((setter) => setter.mock.calls.some(([value]) => String(value).includes('Seleccion')))).toBe(true)

    const file = new File(['Cuenta,Deuda\nUNI-1,D-1\n'], 'incompleto.csv', { type: 'text/csv' })
    state.values = [
      file,
      { encoding: 'UTF-8', delimiter: ',', headers: ['Cuenta', 'Deuda'], mapping: {}, ignoredColumns: [], missingRequiredFields: [], ambiguousFields: {} },
      { debtor_external_reference: 'Cuenta' }, [], null, null, false, false, false, false, null, null, false,
    ]
    state.setters = []
    tree = MultiImportPanel()
    form = findElement(tree, (element) => element.type === 'form')
    await (form!.props as { onSubmit(event: { preventDefault(): void }): Promise<void> }).onSubmit({ preventDefault: vi.fn() })
    expect(state.setters.some((setter) => setter.mock.calls.some(([value]) => String(value).includes('identificadores')))).toBe(true)
  })

  it('reutiliza una simulacion ya validada sin volver a cargar el archivo', async () => {
    prepareState()
    const priorJob = {
      id: 71, mode: 'DRY_RUN', status: 'DRY_RUN_COMPLETED', rejected_rows: 0,
      inserted_rows: 0, updated_rows: 0, unchanged_rows: 2, ignored_columns: [], dry_run_summary: {},
      processed_rows: 2, total_rows: 2, file_name: 'universidad.csv', file_size_bytes: 24,
      created_at: '2026-11-26T00:00:00.000Z',
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ job: priorJob, reused: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ job: priorJob, errors: [], preview: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const form = findElement(MultiImportPanel(), (element) => element.type === 'form')
    await (form!.props as { onSubmit(event: { preventDefault(): void }): Promise<void> }).onSubmit({ preventDefault: vi.fn() })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(state.upload).not.toHaveBeenCalled()
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ action: 'create', forceNewDryRun: false })
  })
})
