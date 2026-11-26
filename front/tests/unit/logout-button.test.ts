import type { ReactElement, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  signOut: vi.fn(async () => undefined),
  setters: [] as Array<ReturnType<typeof vi.fn>>,
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: <T,>(initial: T) => {
      const setter = vi.fn()
      state.setters.push(setter)
      return [initial, setter] as const
    },
  }
})
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: state.replace, refresh: state.refresh }) }))
vi.mock('@/components/auth/auth-provider', () => ({ useAuthState: () => ({ source: 'multi' }) }))
vi.mock('@/lib/services/auth-service', () => ({ signOutCurrentSession: state.signOut }))

import { LogoutButton } from '@/components/layout/logout-button'

function findButton(node: ReactNode): ReactElement<{ onClick?(): void }> | undefined {
  if (!node || typeof node !== 'object') return undefined
  if (Array.isArray(node)) return node.map(findButton).find(Boolean)
  const element = node as ReactElement<{ children?: ReactNode; onClick?(): void }>
  if (element.props.onClick) return element
  return findButton(element.props.children)
}

describe('cierre de sesion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.setters = []
  })

  it('cierra la sesion Multi, elimina la fuente persistida y vuelve al login', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const button = findButton(LogoutButton({}))

    ;(button!.props.onClick as () => void)()
    await vi.waitFor(() => expect(state.replace).toHaveBeenCalledWith('/login'))

    expect(state.signOut).toHaveBeenCalledWith('multi')
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/source', { method: 'DELETE' })
    expect(state.refresh).toHaveBeenCalledOnce()
  })
})
