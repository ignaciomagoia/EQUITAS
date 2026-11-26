import { cookies } from 'next/headers'

import { EQUITAS_AUTH_SOURCE_COOKIE, isSupabaseSource } from '@/lib/auth/auth-source'
import type { SupabaseSource } from '@/lib/supabase-config'

// Las pruebas unitarias de datos no tienen request de Next. En ese contexto el
// proveedor historico es el fallback seguro y no se consulta ninguna segunda base.
export async function getCurrentSupabaseSource(): Promise<SupabaseSource> {
  try {
    const cookieStore = await cookies()
    const cookieValue = cookieStore.get(EQUITAS_AUTH_SOURCE_COOKIE)?.value
    return isSupabaseSource(cookieValue) ? cookieValue : 'legacy'
  } catch {
    return 'legacy'
  }
}
