import type { ReactElement, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  values: [] as unknown[],
  upload: vi.fn(async () => ({ error: null })),
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: <T,>(initial: T) => [(state.values.length ? state.values.shift() : initial) as T, vi.fn()] as const,
    useEffect: () => undefined,
    useMemo: <T,>(factory: () => T) => factory(),
    useCallback: <T extends (...arguments_: never[]) => unknown>(callback: T) => callback,
    useRef: <T,>(value: T) => ({ current: value }),
  }
})
vi.mock('@/lib/supabase-browser', () => ({
  createBrowserSupabaseClient: vi.fn(() => ({ storage: { from: () => ({ uploadToSignedUrl: state.upload }) } })),
}))

import { ImportPanel } from '@/components/imports/import-panel'

function findForm(node: ReactNode): ReactElement | undefined {
  if (!node || typeof node !== 'object') return undefined
  if (Array.isArray(node)) return node.map(findForm).find(Boolean)
  const element = node as ReactElement<{ children?: ReactNode }>
  if (element.type === 'form') return element
  return findForm(element.props.children)
}

describe('flujo del importador de La Falda', () => {
  beforeEach(() => {
    state.values = [
      new File(['Cuenta,DEUD_id\n3,100\n'], 'lafalda.csv', { type: 'text/csv' }),
      [], null, null, false, false, 'dry_run', false, false, null, null,
    ]
    state.upload.mockClear()
    vi.stubGlobal('crypto', { subtle: { digest: vi.fn(async () => new Uint8Array(32).buffer) } })
  })

  it('crea una simulaciÃ³n, carga el archivo privado y la encola sin APPLY', async () => {
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        job: { id: 41 }, upload: { bucket: 'lafalda-imports', path: 'tenant-1/source.csv', token: 'short-lived' },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ job: { id: 41 }, dispatch: { status: 'dispatched' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchImplementation)

    const form = findForm(ImportPanel({ applyEnabled: true }))
    expect(form).toBeDefined()
    await (form!.props as { onSubmit: (event: { preventDefault(): void }) => Promise<void> }).onSubmit({ preventDefault: vi.fn() })

    const createPayload = JSON.parse(fetchImplementation.mock.calls[0][1].body)
    expect(createPayload).toMatchObject({ action: 'create', fileName: 'lafalda.csv', mode: 'dry_run' })
    expect(state.upload).toHaveBeenCalledWith('tenant-1/source.csv', 'short-lived', expect.any(File), { contentType: 'text/csv' })
    expect(JSON.parse(fetchImplementation.mock.calls[1][1].body)).toEqual({ action: 'queue', jobId: 41 })
  })
})
