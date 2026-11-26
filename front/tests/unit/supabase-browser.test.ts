import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { createBrowserClient } = vi.hoisted(() => ({ createBrowserClient: vi.fn() }))

vi.mock('@supabase/ssr', () => ({ createBrowserClient }))
vi.mock('@/lib/supabase-config', () => ({
  getSupabasePublicConfiguration: (source: 'legacy' | 'multi') =>
    source === 'multi'
      ? {
          configured: true,
          publishableKey: 'multi-public-key',
          url: 'https://multi-project.supabase.co',
        }
      : {
          configured: true,
          publishableKey: 'legacy-public-key',
          url: 'https://legacy-project.supabase.co',
        },
}))

describe('R-SEG-02: clientes de navegador separados por proyecto Supabase', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('window', {})
    createBrowserClient
      .mockReturnValueOnce({ source: 'legacy-client' })
      .mockReturnValueOnce({ source: 'multi-client' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('no reutiliza el singleton global entre La Falda y Multiinstitucion', async () => {
    const { createBrowserSupabaseClient } = await import('@/lib/supabase-browser')

    const legacyClient = createBrowserSupabaseClient('legacy')
    const multiClient = createBrowserSupabaseClient('multi')
    const repeatedMultiClient = createBrowserSupabaseClient('multi')

    expect(legacyClient).toEqual({ source: 'legacy-client' })
    expect(multiClient).toEqual({ source: 'multi-client' })
    expect(repeatedMultiClient).toBe(multiClient)
    expect(createBrowserClient).toHaveBeenCalledTimes(2)
    expect(createBrowserClient).toHaveBeenNthCalledWith(
      1,
      'https://legacy-project.supabase.co',
      'legacy-public-key',
      { isSingleton: false }
    )
    expect(createBrowserClient).toHaveBeenNthCalledWith(
      2,
      'https://multi-project.supabase.co',
      'multi-public-key',
      { isSingleton: false }
    )
  })
})
