import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  authorized: true,
  configured: true,
  set: vi.fn(),
}))

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: () => state.cookie ? { value: state.cookie } : undefined })),
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => state.configured
    ? { auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })) } }
    : null),
}))
vi.mock('@/lib/services/auth-service', () => ({
  validateAuthUserTenantAccess: vi.fn(async () => ({ isAuthorized: state.authorized, message: 'Sin permiso' })),
}))
vi.mock('@/lib/services/multi-auth-service', () => ({
  validateMultiInstitutionAccess: vi.fn(async () => ({ isAuthorized: state.authorized, message: 'Sin permiso' })),
}))

import { DELETE, GET, POST } from '@/app/api/auth/source/route'

beforeEach(() => {
  state.cookie = undefined
  state.authorized = true
  state.configured = true
  state.set.mockClear()
})

describe('cookie de origen de autenticaciÃ³n', () => {
  it('usa Legacy por defecto y conserva el origen Multi vÃ¡lido', async () => {
    await expect((await GET()).json()).resolves.toEqual({ source: 'legacy' })
    state.cookie = 'multi'
    await expect((await GET()).json()).resolves.toEqual({ source: 'multi' })
  })

  it('confirma la cookie solo despuÃ©s de validar una sesiÃ³n Multi autorizada', async () => {
    const response = await POST(new Request('http://localhost/api/auth/source', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'multi' }),
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ source: 'multi' })
    expect(response.headers.get('set-cookie')).toContain('equitas-auth-source=multi')
  })

  it('rechaza proveedores invÃ¡lidos y sesiones sin autorizaciÃ³n', async () => {
    const invalid = await POST(new Request('http://localhost/api/auth/source', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'otro' }),
    }))
    expect(invalid.status).toBe(400)

    state.authorized = false
    const denied = await POST(new Request('http://localhost/api/auth/source', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'legacy' }),
    }))
    expect(denied.status).toBe(403)
    await expect(denied.json()).resolves.toEqual({ error: 'Sin permiso' })
  })

  it('borra el origen al cerrar sesiÃ³n sin afectar ningÃºn proveedor', async () => {
    const response = await DELETE()

    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toContain('equitas-auth-source=;')
  })
})
