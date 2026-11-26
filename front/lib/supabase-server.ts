import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'

import {
  getSupabasePublicConfiguration,
  type SupabaseSource,
} from '@/lib/supabase-config'
import { getCurrentSupabaseSource } from '@/lib/auth/auth-source-server'

export { getCurrentSupabaseSource } from '@/lib/auth/auth-source-server'

export async function createServerSupabaseClient(source?: SupabaseSource) {
  const resolvedSource = source ?? (await getCurrentSupabaseSource())
  const configuration = getSupabasePublicConfiguration(resolvedSource)

  if (!configuration.configured) {
    return null
  }

  const cookieStore = await cookies()

  return createServerClient(configuration.url, configuration.publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options)
          })
        } catch {
          // Server Components pueden leer cookies, pero no siempre escribirlas.
        }
      },
    },
  })
}

export function createServerAdminSupabaseClient(source: SupabaseSource = 'legacy') {
  const configuration = getSupabasePublicConfiguration(source)
  const serviceRoleKey = (
    source === 'multi'
      ? process.env.MULTI_SUPABASE_SERVICE_ROLE_KEY ?? ''
      : process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  ).trim()

  if (!configuration.configured || !serviceRoleKey) {
    return null
  }

  return createClient(configuration.url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}

export function createLegacyServerAdminSupabaseClient() {
  return createServerAdminSupabaseClient('legacy')
}

export function createMultiServerAdminSupabaseClient() {
  return createServerAdminSupabaseClient('multi')
}
