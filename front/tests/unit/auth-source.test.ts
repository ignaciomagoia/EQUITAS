import { describe, expect, it } from 'vitest'

import { isSupabaseSource, normalizeLoginEmail } from '@/lib/auth/auth-source'

describe('enrutamiento seguro entre proveedores Supabase', () => {
  it('acepta exclusivamente los dos proveedores permitidos', () => {
    expect(isSupabaseSource('legacy')).toBe(true)
    expect(isSupabaseSource('multi')).toBe(true)
    expect(isSupabaseSource('testing')).toBe(false)
    expect(isSupabaseSource(undefined)).toBe(false)
  })

  it('normaliza email sin aceptar valores no textuales', () => {
    expect(normalizeLoginEmail('  Admin@Universidad.Example.Test ')).toBe(
      'admin@universidad.example.test'
    )
    expect(normalizeLoginEmail(null)).toBe('')
  })
})
