import { NextResponse } from 'next/server'

import { normalizeLoginEmail } from '@/lib/auth/auth-source'
import { createMultiServerAdminSupabaseClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  let body: { email?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Solicitud invalida.' }, { status: 400 })
  }

  const email = normalizeLoginEmail(body.email)
  if (!email) {
    return NextResponse.json({ error: 'Ingrese un email valido.' }, { status: 400 })
  }

  const multiAdmin = createMultiServerAdminSupabaseClient()
  if (!multiAdmin) {
    return NextResponse.json({ source: 'legacy' })
  }

  const response = await multiAdmin
    .from('app_user')
    .select('id')
    .eq('email', email)
    .eq('status', 'ACTIVE')
    .limit(1)

  if (response.error) {
    return NextResponse.json(
      { error: 'No se pudo resolver la plataforma de acceso. Intente nuevamente.' },
      { status: 503 }
    )
  }

  return NextResponse.json({ source: (response.data?.length ?? 0) > 0 ? 'multi' : 'legacy' })
}
