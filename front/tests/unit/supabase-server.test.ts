import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  source: 'multi' as 'legacy' | 'multi',
  configured: true,
  createdServer: [] as Array<{ url: string; key: string }>,
  createdAdmin: [] as Array<{ url: string; key: string; options: unknown }>,
  cookies: [{ name: 'sb-session', value: 'session' }],
  writes: [] as Array<{ name: string; value: string }>,
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn((url: string, key: string, options: { cookies: { getAll: () => unknown[] } }) => {
    state.createdServer.push({ url, key })
    options.cookies.getAll()
    return { kind: 'server-client' }
  }),
}))
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn((url: string, key: string, options: unknown) => {
    state.createdAdmin.push({ url, key, options })
    return { kind: 'admin-client' }
  }),
}))
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    getAll: () => state.cookies,
    set: (name: string, value: string) => state.writes.push({ name, value }),
  })),
}))
vi.mock('@/lib/supabase-config', () => ({
  getSupabasePublicConfiguration: vi.fn((source: 'legacy' | 'multi') => ({
    url: `https://${source}.example.supabase.co`, publishableKey: `${source}-public`, configured: state.configured,
  })),
}))
vi.mock('@/lib/auth/auth-source-server', () => ({ getCurrentSupabaseSource: vi.fn(async () => state.source) }))

import {
  createLegacyServerAdminSupabaseClient,
  createMultiServerAdminSupabaseClient,
  createServerAdminSupabaseClient,
  createServerSupabaseClient,
} from '@/lib/supabase-server'

beforeEach(() => {
  state.source = 'multi'
  state.configured = true
  state.createdServer = []
  state.createdAdmin = []
  state.writes = []
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'legacy-service')
  vi.stubEnv('MULTI_SUPABASE_SERVICE_ROLE_KEY', 'multi-service')
})

describe('clientes Supabase de servidor', () => {
  it('resuelve el cliente de sesion contra la fuente actual y permite leer cookies', async () => {
    await expect(createServerSupabaseClient()).resolves.toEqual({ kind: 'server-client' })
    expect(state.createdServer).toEqual([{ url: 'https://multi.example.supabase.co', key: 'multi-public' }])
  })

  it('no crea un cliente de sesion si falta configuracion publica', async () => {
    state.configured = false
    await expect(createServerSupabaseClient('legacy')).resolves.toBeNull()
    expect(state.createdServer).toEqual([])
  })

  it('elige la service role correspondiente a cada fuente sin compartirla', () => {
    expect(createLegacyServerAdminSupabaseClient()).toEqual({ kind: 'admin-client' })
    expect(createMultiServerAdminSupabaseClient()).toEqual({ kind: 'admin-client' })
    expect(state.createdAdmin.map(({ url, key }) => ({ url, key }))).toEqual([
      { url: 'https://legacy.example.supabase.co', key: 'legacy-service' },
      { url: 'https://multi.example.supabase.co', key: 'multi-service' },
    ])
  })

  it('bloquea el cliente administrativo si falta la clave privada o la configuracion', () => {
    vi.stubEnv('MULTI_SUPABASE_SERVICE_ROLE_KEY', '')
    expect(createServerAdminSupabaseClient('multi')).toBeNull()
    state.configured = false
    expect(createServerAdminSupabaseClient('legacy')).toBeNull()
    expect(state.createdAdmin).toEqual([])
  })
})
