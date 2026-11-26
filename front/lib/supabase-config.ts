export type SupabaseSource = 'legacy' | 'multi'

type SupabasePublicConfiguration = {
  url: string
  publishableKey: string
  configured: boolean
}

// Evita errores cuando la URL viene con /rest/v1 o barras finales.
export function normalizeSupabaseUrl(url: string): string {
  const cleanUrl = url.trim().replace(/\/+$/, '')

  if (cleanUrl.endsWith('/rest/v1')) {
    return cleanUrl.replace(/\/rest\/v1$/, '')
  }

  return cleanUrl
}

function readPublicConfiguration(source: SupabaseSource): SupabasePublicConfiguration {
  const rawUrl =
    source === 'multi'
      ? process.env.NEXT_PUBLIC_MULTI_SUPABASE_URL ?? ''
      : process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const publishableKey =
    source === 'multi'
      ? process.env.NEXT_PUBLIC_MULTI_SUPABASE_PUBLISHABLE_KEY ?? ''
      : process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? ''
  const url = normalizeSupabaseUrl(rawUrl)

  return {
    url,
    publishableKey: publishableKey.trim(),
    configured: Boolean(url && publishableKey.trim()),
  }
}

export function getSupabasePublicConfiguration(source: SupabaseSource): SupabasePublicConfiguration {
  return readPublicConfiguration(source)
}

const legacyConfiguration = readPublicConfiguration('legacy')

// Alias de compatibilidad para el proveedor historico de La Falda.
export const supabaseUrl = legacyConfiguration.url
export const supabasePublishableKey = legacyConfiguration.publishableKey

export const hasSupabaseCredentials = legacyConfiguration.configured
