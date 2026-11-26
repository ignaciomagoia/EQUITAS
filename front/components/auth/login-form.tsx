'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { LogIn } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  mapAuthErrorMessage,
  signInWithPassword,
  signOutCurrentSession,
  validateCurrentUserTenantAccess,
} from '@/lib/services/auth-service'
import { validateCurrentMultiInstitutionAccess } from '@/lib/services/multi-auth-service'
import type { SupabaseSource } from '@/lib/supabase-config'

type LoginFormProps = {
  nextPath: string
}

async function resolveLoginSource(email: string): Promise<SupabaseSource> {
  const response = await fetch('/api/auth/resolve-provider', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  const payload = (await response.json().catch(() => null)) as { source?: unknown; error?: string } | null

  if (!response.ok || (payload?.source !== 'legacy' && payload?.source !== 'multi')) {
    throw new Error(payload?.error ?? 'No se pudo resolver la plataforma de acceso.')
  }

  return payload.source
}

async function readSavedSource(): Promise<SupabaseSource> {
  const response = await fetch('/api/auth/source', { cache: 'no-store' })
  const payload = (await response.json().catch(() => null)) as { source?: unknown } | null
  return payload?.source === 'multi' ? 'multi' : 'legacy'
}

async function persistAuthSource(source: SupabaseSource) {
  const response = await fetch('/api/auth/source', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  })
  const payload = (await response.json().catch(() => null)) as { error?: string } | null

  if (!response.ok) {
    throw new Error(payload?.error ?? 'No se pudo confirmar la sesion institucional.')
  }
}

export function LoginForm({ nextPath }: LoginFormProps) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isCheckingSession, setIsCheckingSession] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function checkExistingSession() {
      const source = await readSavedSource()
      const result =
        source === 'multi'
          ? await validateCurrentMultiInstitutionAccess()
          : await validateCurrentUserTenantAccess('legacy')

      if (cancelled) {
        return
      }

      if (result.isAuthorized) {
        router.replace(nextPath)
        return
      }

      setIsCheckingSession(false)
    }

    checkExistingSession()

    return () => {
      cancelled = true
    }
  }, [nextPath, router])

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setErrorMessage(null)
    setIsSubmitting(true)

    let source: SupabaseSource
    try {
      source = await resolveLoginSource(email.trim())
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'No se pudo iniciar sesion.')
      setIsSubmitting(false)
      return
    }

    const signInResult = await signInWithPassword(email.trim(), password, source)

    if (signInResult.error) {
      setErrorMessage(mapAuthErrorMessage(signInResult.error))
      setIsSubmitting(false)
      return
    }

    const access =
      source === 'multi'
        ? await validateCurrentMultiInstitutionAccess()
        : await validateCurrentUserTenantAccess('legacy')

    if (!access.isAuthorized) {
      await signOutCurrentSession(source)
      setErrorMessage(
        access.message ??
          'Tus credenciales son correctas, pero no tienes permisos activos para ingresar.'
      )
      setIsSubmitting(false)
      return
    }

    try {
      await persistAuthSource(source)
    } catch (error) {
      await signOutCurrentSession(source)
      setErrorMessage(error instanceof Error ? error.message : 'No se pudo confirmar la sesion.')
      setIsSubmitting(false)
      return
    }

    // Recarga el arbol de Server Components con el proveedor autenticado en la cookie HttpOnly.
    window.location.assign(nextPath)
  }

  if (isCheckingSession) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
        Validando sesion...
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor="email" className="text-sm font-medium text-slate-700">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none ring-[#163a63]/20 transition placeholder:text-slate-400 focus:ring-4"
          placeholder="admin@municipio.gob.ar"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="password" className="text-sm font-medium text-slate-700">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none ring-[#163a63]/20 transition placeholder:text-slate-400 focus:ring-4"
          placeholder="********"
        />
      </div>

      {errorMessage && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}

      <Button type="submit" className="w-full" disabled={isSubmitting}>
        <LogIn className="size-4" />
        {isSubmitting ? 'Ingresando...' : 'Iniciar sesion'}
      </Button>
    </form>
  )
}
