import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  values: [] as unknown[],
  setters: [] as Array<ReturnType<typeof vi.fn>>,
  multiAccess: vi.fn(),
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

const supabase = {
  auth: {
    getSession: vi.fn(async () => ({ data: { session: { user: { id: 'multi-user' } } }, error: null })),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
  },
}
vi.mock('@/lib/supabase-browser', () => ({ createBrowserSupabaseClient: vi.fn(() => supabase) }))
vi.mock('@/lib/services/multi-auth-service', () => ({ validateMultiInstitutionAccess: state.multiAccess }))
vi.mock('@/lib/services/auth-service', () => ({ validateAuthUserTenantAccess: vi.fn() }))

import { AuthProvider } from '@/components/auth/auth-provider'

beforeEach(() => {
  vi.clearAllMocks()
  state.multiAccess.mockResolvedValue({
    isAuthorized: true,
    context: { appUserId: 'app-1', authUserId: 'multi-user', institutionId: '7', institutionName: 'Universidad Demo', role: 'institution_admin' },
  })
  state.values = ['multi', true, null, null, null, null, false, false, false]
  state.setters = []
})

describe('AuthProvider multiinstitucion', () => {
  it('revalida la sesion contra Multi y conserva la institucion autorizada', async () => {
    const tree = AuthProvider({ children: null }) as ReactElement<{ value: { refreshAuthState(): Promise<void> } }>

    await tree.props.value.refreshAuthState()

    expect(supabase.auth.getSession).toHaveBeenCalledOnce()
    expect(state.multiAccess).toHaveBeenCalledWith('multi-user', supabase)
    expect(state.setters.some((setter) => setter.mock.calls.some(([value]) => value?.name === 'Universidad Demo'))).toBe(true)
    expect(state.setters.some((setter) => setter.mock.calls.some(([value]) => value === true))).toBe(true)
  })
})
