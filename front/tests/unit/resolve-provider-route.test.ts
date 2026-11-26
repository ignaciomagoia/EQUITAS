import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ configured: true, result: { data: [{ id: 'user-1' }], error: null as unknown } }))

class Query {
  select(columns: string) { void columns; return this }
  eq(column: string, value: string) { void column; void value; return this }
  limit(value: number) { void value; return Promise.resolve(state.result) }
}

vi.mock('@/lib/supabase-server', () => ({
  createMultiServerAdminSupabaseClient: vi.fn(() => state.configured ? { from: () => new Query() } : null),
}))

import { POST } from '@/app/api/auth/resolve-provider/route'

beforeEach(() => {
  state.configured = true
  state.result = { data: [{ id: 'user-1' }], error: null }
})

describe('resoluciÃ³n del proveedor de autenticaciÃ³n', () => {
  it('dirige a MultiinstituciÃ³n solamente si el email estÃ¡ habilitado allÃ­', async () => {
    const response = await POST(new Request('http://localhost/api/auth/resolve-provider', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ' ADMIN@UNIVERSIDAD-DEMO.EXAMPLE ' }),
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ source: 'multi' })
  })

  it('mantiene el acceso legado cuando el email no tiene app_user Multi activo', async () => {
    state.result = { data: [], error: null }

    const response = await POST(new Request('http://localhost/api/auth/resolve-provider', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'empleado@lafalda.gob.ar' }),
    }))

    await expect(response.json()).resolves.toEqual({ source: 'legacy' })
  })

  it('informa error de configuraciÃ³n sin revelar detalles internos', async () => {
    state.configured = false

    const response = await POST(new Request('http://localhost/api/auth/resolve-provider', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@universidad-demo.example' }),
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ source: 'legacy' })
  })

  it('rechaza cuerpos invÃ¡lidos antes de consultar Supabase', async () => {
    const response = await POST(new Request('http://localhost/api/auth/resolve-provider', { method: 'POST', body: '{}' }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Ingrese un email valido.' })
  })
})
