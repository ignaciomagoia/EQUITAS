import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

import {
  getSupabasePublicConfiguration,
} from '@/lib/supabase-config'
import { EQUITAS_AUTH_SOURCE_COOKIE, isSupabaseSource } from '@/lib/auth/auth-source'

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({
    request,
  })

  const sourceCookie = request.cookies.get(EQUITAS_AUTH_SOURCE_COOKIE)?.value
  const source = isSupabaseSource(sourceCookie) ? sourceCookie : 'legacy'
  const configuration = getSupabasePublicConfiguration(source)

  if (!configuration.configured) {
    return response
  }

  const supabase = createServerClient(configuration.url, configuration.publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value)
        })

        response = NextResponse.next({
          request,
        })

        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options)
        })

        Object.entries(headers).forEach(([key, value]) => {
          response.headers.set(key, value)
        })
      },
    },
  })

  await supabase.auth.getUser()

  return response
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|icon.png|icono.png|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}
