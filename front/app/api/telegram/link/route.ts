import { createServerSupabaseClient } from '@/lib/supabase-server'
import {
  buildTelegramDeepLink,
  createTelegramAccessToken,
  getTelegramAdminClient,
  getTelegramConfiguration,
  hashTelegramAccessToken,
  TELEGRAM_ACCESS_LINK_TABLE,
} from '@/lib/telegram-service'
import { validateAuthUserTenantAccess } from '@/lib/services/auth-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status })
}

export async function POST(request: Request) {
  const sessionClient = await createServerSupabaseClient()

  if (!sessionClient) {
    return jsonError('Supabase no esta configurado.', 503)
  }

  const {
    data: { user },
    error: authError,
  } = await sessionClient.auth.getUser()

  if (authError || !user) {
    return jsonError('Sesion requerida.', 401)
  }

  const access = await validateAuthUserTenantAccess(user.id, sessionClient)

  if (!access.isAuthorized || !access.context) {
    return jsonError('No tenes permisos para generar un acceso de Telegram.', 403)
  }

  let payload: { personId?: unknown }
  try {
    payload = (await request.json()) as { personId?: unknown }
  } catch {
    return jsonError('El cuerpo de la solicitud no es valido.', 400)
  }

  const personId = Number(payload.personId)
  const tenantId = Number(access.context.tenantId)

  if (!Number.isSafeInteger(personId) || personId <= 0 || !Number.isSafeInteger(tenantId)) {
    return jsonError('La persona solicitada no es valida.', 400)
  }

  const telegramConfiguration = getTelegramConfiguration()
  const adminClient = getTelegramAdminClient()

  if (!telegramConfiguration || !adminClient) {
    return jsonError('La integracion de Telegram aun no esta configurada.', 503)
  }

  const relationResponse = await adminClient
    .from('debtor_person')
    .select('debtor')
    .eq('person', personId)
    .eq('active', true)

  if (relationResponse.error) {
    return jsonError('No se pudo validar la persona solicitada.', 500)
  }

  const debtorIds = Array.from(
    new Set(
      ((relationResponse.data as Array<{ debtor: number | string }> | null) ?? [])
        .map((row) => Number(row.debtor))
        .filter((debtorId) => Number.isSafeInteger(debtorId) && debtorId > 0)
    )
  )

  if (debtorIds.length === 0) {
    return jsonError('La persona no tiene objetos de deuda activos.', 404)
  }

  const debtorResponse = await adminClient
    .from('debtor')
    .select('id')
    .eq('tenant', tenantId)
    .in('id', debtorIds)
    .limit(1)

  if (debtorResponse.error) {
    return jsonError('No se pudo validar el acceso al objeto de deuda.', 500)
  }

  if (!debtorResponse.data?.length) {
    return jsonError('La persona no pertenece al municipio de la sesion.', 403)
  }

  const deactivateResponse = await adminClient
    .from(TELEGRAM_ACCESS_LINK_TABLE)
    .update({ active: false })
    .eq('tenant', tenantId)
    .eq('person', personId)
    .eq('active', true)
    .is('telegram_chat_id', null)

  if (deactivateResponse.error) {
    return jsonError('No se pudo renovar el enlace de Telegram.', 500)
  }

  const token = createTelegramAccessToken()
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString()
  const insertResponse = await adminClient.from(TELEGRAM_ACCESS_LINK_TABLE).insert({
    tenant: tenantId,
    person: personId,
    token_hash: hashTelegramAccessToken(token),
    expires_at: expiresAt,
  })

  if (insertResponse.error) {
    return jsonError('No se pudo crear el enlace de Telegram.', 500)
  }

  const url = buildTelegramDeepLink(telegramConfiguration.botUsername, token)

  if (!url) {
    return jsonError('El usuario configurado para el bot no es valido.', 500)
  }

  return Response.json({ url, expiresAt }, { headers: { 'Cache-Control': 'no-store' } })
}
