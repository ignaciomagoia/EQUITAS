import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'

import {
  getSupabasePublicConfiguration,
  type SupabaseSource,
} from '@/lib/supabase-config'

const browserClients = new Map<SupabaseSource, SupabaseClient>()

export function createBrowserSupabaseClient(source: SupabaseSource = 'legacy') {
  const configuration = getSupabasePublicConfiguration(source)

  if (!configuration.configured) {
    return null
  }

  if (typeof window !== 'undefined') {
    const cachedClient = browserClients.get(source)
    if (cachedClient) {
      return cachedClient
    }
  }

  // @supabase/ssr usa un singleton global por defecto. EQUITAS necesita un
  // cliente distinto por proyecto para que una sesion de La Falda no reutilice
  // la URL o clave de Multiinstitucion, y viceversa.
  const client = createBrowserClient(configuration.url, configuration.publishableKey, {
    isSingleton: false,
  })

  if (typeof window !== 'undefined') {
    browserClients.set(source, client)
  }

  return client
}
