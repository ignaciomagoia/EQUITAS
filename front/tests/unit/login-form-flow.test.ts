import type { ReactElement, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  values: [] as unknown[],
  setters: [] as Array<ReturnType<typeof vi.fn>>,
  replace: vi.fn(),
  signIn: vi.fn(),
  legacyAccess: vi.fn(),
  multiAccess: vi.fn(),
  signOut: vi.fn(),
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
  }
})
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: state.replace }) }))
vi.mock('@/lib/services/auth-service', () => ({
  mapAuthErrorMessage: vi.fn(() => 'Credenciales rechazadas'),
  signInWithPassword: (...args: unknown[]) => state.signIn(...args),
  signOutCurrentSession: (...args: unknown[]) => state.signOut(...args),
  validateCurrentUserTenantAccess: (...args: unknown[]) => state.legacyAccess(...args),
}))
vi.mock('@/lib/services/multi-auth-service', () => ({
  validateCurrentMultiInstitutionAccess: (...args: unknown[]) => state.multiAccess(...args),
}))

import { LoginForm } from '@/components/auth/login-form'

function findElement(node: ReactNode, predicate: (element: ReactElement) => boolean): ReactElement | undefined {
  if (!node || typeof node !== 'object') return undefined
  if (Array.isArray(node)) return node.map((child) => findElement(child, predicate)).find(Boolean)
  const element = node as ReactElement<{ children?: ReactNode }>
  return predicate(element) ? element : findElement(element.props.children, predicate)
}

function prepare(email = 'admin@universidad-demo.example') {
  vi.clearAllMocks()
  state.values = [email, 'password-segura', null, false, false]
  state.setters = []
  state.signIn.mockResolvedValue({ error: null })
  state.multiAccess.mockResolvedValue({ isAuthorized: true })
  state.legacyAccess.mockResolvedValue({ isAuthorized: false })
  state.signOut.mockResolvedValue(undefined)
  vi.stubGlobal('window', { location: { assign: vi.fn() } })
}

describe('flujo de ingreso con proveedor dual', () => {
  beforeEach(() => { prepare() })

  it('autentica Multiinstitucion, valida permisos y persiste la fuente antes de navegar', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ source: 'multi' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const form = findElement(LoginForm({ nextPath: '/'}), (element) => element.type === 'form')
    await (form!.props as { onSubmit(event: { preventDefault(): void }): Promise<void> }).onSubmit({ preventDefault: vi.fn() })

    expect(state.signIn).toHaveBeenCalledWith('admin@universidad-demo.example', 'password-segura', 'multi')
    expect(state.multiAccess).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/auth/source', expect.objectContaining({ method: 'POST' }))
    expect(window.location.assign).toHaveBeenCalledWith('/')
  })

  it('muestra el error autenticacion y no persiste una fuente cuando Supabase rechaza las credenciales', async () => {
    state.signIn.mockResolvedValue({ error: { message: 'invalid login credentials' } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ source: 'multi' }), { status: 200 })))

    const form = findElement(LoginForm({ nextPath: '/dashboard' }), (element) => element.type === 'form')
    await (form!.props as { onSubmit(event: { preventDefault(): void }): Promise<void> }).onSubmit({ preventDefault: vi.fn() })

    expect(state.multiAccess).not.toHaveBeenCalled()
    expect(state.setters.some((setter) => setter.mock.calls.some(([message]) => message === 'Credenciales rechazadas'))).toBe(true)
    expect(window.location.assign).not.toHaveBeenCalled()
  })
})
