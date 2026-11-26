import type { SupabaseSource } from '@/lib/supabase-config'

export const EQUITAS_AUTH_SOURCE_COOKIE = 'equitas-auth-source'

export function isSupabaseSource(value: unknown): value is SupabaseSource {
  return value === 'legacy' || value === 'multi'
}

export function normalizeLoginEmail(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function authSourceCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  }
}
