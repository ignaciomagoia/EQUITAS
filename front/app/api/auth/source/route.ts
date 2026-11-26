import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'

import {
  EQUITAS_AUTH_SOURCE_COOKIE,
  authSourceCookieOptions,
  isSupabaseSource,
} from '@/lib/auth/auth-source'
import { validateAuthUserTenantAccess } from '@/lib/services/auth-service'
import { validateMultiInstitutionAccess } from '@/lib/services/multi-auth-service'
import { createServerSupabaseClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function clearSourceCookie(response: NextResponse) {
  response.cookies.set(EQUITAS_AUTH_SOURCE_COOKIE, '', {
    ...authSourceCookieOptions(),
    maxAge: 0,
  })
}

export async function GET() {
  const cookieStore = await cookies()
  const source = cookieStore.get(EQUITAS_AUTH_SOURCE_COOKIE)?.value
  return NextResponse.json({ source: isSupabaseSource(source) ? source : 'legacy' })
}

export async function POST(request: Request) {
  let body: { source?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Solicitud invalida.' }, { status: 400 })
  }

  if (!isSupabaseSource(body.source)) {
    return NextResponse.json({ error: 'Proveedor de autenticacion invalido.' }, { status: 400 })
  }

  const sessionClient = await createServerSupabaseClient(body.source)
  if (!sessionClient) {
    return NextResponse.json({ error: 'Proveedor no configurado.' }, { status: 503 })
  }

  const { data, error } = await sessionClient.auth.getUser()
  if (error || !data.user) {
    return NextResponse.json({ error: 'Sesion requerida.' }, { status: 401 })
  }

  const access =
    body.source === 'multi'
      ? await validateMultiInstitutionAccess(data.user.id, sessionClient)
      : await validateAuthUserTenantAccess(data.user.id, sessionClient)

  if (!access.isAuthorized) {
    return NextResponse.json({ error: access.message ?? 'Acceso no autorizado.' }, { status: 403 })
  }

  const response = NextResponse.json({ source: body.source })
  response.cookies.set(EQUITAS_AUTH_SOURCE_COOKIE, body.source, authSourceCookieOptions())
  return response
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true })
  clearSourceCookie(response)
  return response
}
