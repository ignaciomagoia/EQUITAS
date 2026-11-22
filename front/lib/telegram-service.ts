import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { normalizeSupabaseUrl } from '@/lib/supabase-config'

export const TELEGRAM_ACCESS_LINK_TABLE = 'telegram_access_link'

export const TELEGRAM_MAIN_MENU = [
  ['Consultar obligaciones', 'Confirmar recepcion'],
  ['Actualizar datos', 'Solicitar contacto'],
  ['Canales de atencion', 'Informar inconveniente'],
]

type TelegramRow = Record<string, unknown>

export type TelegramConfiguration = {
  botToken: string
  botUsername: string
  webhookSecret: string
}

export type TelegramDebtSummaryItem = {
  identifier: string
  type: string
  totalDebt: number
  overdueDebt: number
  debtCount: number
  overdueDebtCount: number
  oldestDebtDays: number
}

function readEnvironmentValue(name: string) {
  return (process.env[name] ?? '').trim()
}

function asText(value: unknown) {
  return value === null || value === undefined ? '' : String(value).trim()
}

function asNumber(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 0,
  }).format(value)
}

function getSupabaseServiceConfiguration() {
  const url = normalizeSupabaseUrl(
    readEnvironmentValue('SUPABASE_URL') || readEnvironmentValue('NEXT_PUBLIC_SUPABASE_URL')
  )
  const serviceRoleKey = readEnvironmentValue('SUPABASE_SERVICE_ROLE_KEY')

  if (!url || !serviceRoleKey) {
    return null
  }

  return { url, serviceRoleKey }
}

export function getTelegramConfiguration(): TelegramConfiguration | null {
  const botToken = readEnvironmentValue('TELEGRAM_BOT_TOKEN')
  const botUsername = readEnvironmentValue('TELEGRAM_BOT_USERNAME').replace(/^@/, '')
  const webhookSecret = readEnvironmentValue('TELEGRAM_WEBHOOK_SECRET')

  if (!botToken || !botUsername || !webhookSecret) {
    return null
  }

  return { botToken, botUsername, webhookSecret }
}

export function getTelegramAdminClient(): SupabaseClient | null {
  const configuration = getSupabaseServiceConfiguration()

  if (!configuration) {
    return null
  }

  return createClient(configuration.url, configuration.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}

export function createTelegramAccessToken() {
  return randomBytes(32).toString('base64url')
}

export function hashTelegramAccessToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export function buildTelegramDeepLink(botUsername: string, token: string) {
  const normalizedUsername = botUsername.replace(/^@/, '').trim()

  if (!/^[A-Za-z0-9_]{5,}$/.test(normalizedUsername) || !token) {
    return null
  }

  return `https://t.me/${normalizedUsername}?start=${encodeURIComponent(token)}`
}

export function isTelegramWebhookSecretValid(expectedSecret: string, receivedSecret: string | null) {
  if (!expectedSecret || !receivedSecret) {
    return false
  }

  const expected = Buffer.from(expectedSecret)
  const received = Buffer.from(receivedSecret)

  return expected.length === received.length && timingSafeEqual(expected, received)
}

export function formatTelegramDebtMessages(personName: string, items: TelegramDebtSummaryItem[]) {
  if (items.length === 0) {
    return ['No se encontraron obligaciones municipales activas asociadas a este acceso.']
  }

  const header = `Resumen de obligaciones de ${personName}:\n\n`
  const blocks = items.map((item) =>
    [
      `${item.identifier} (${item.type})`,
      `Saldo total: ${formatCurrency(item.totalDebt)}`,
      `Saldo vencido: ${formatCurrency(item.overdueDebt)}`,
      `Deudas: ${item.debtCount} | Vencidas: ${item.overdueDebtCount}`,
      `Atraso maximo: ${item.oldestDebtDays} dias`,
    ].join('\n')
  )
  const messages: string[] = []
  let currentMessage = header

  for (const block of blocks) {
    const nextBlock = `${currentMessage === header ? '' : '\n\n'}${block}`

    if (currentMessage.length + nextBlock.length > 3500 && currentMessage !== header) {
      messages.push(currentMessage)
      currentMessage = block
      continue
    }

    currentMessage += nextBlock
  }

  if (currentMessage) {
    messages.push(currentMessage)
  }

  return messages
}

export function formatMunicipalAttentionMessage() {
  return [
    'Canales de atencion municipal',
    '',
    'Municipio de La Falda',
    'Ubicado en el Valle de Punilla, al noroeste de la provincia de Cordoba, sobre el faldeo de las Sierras Chicas.',
    '',
    'Direccion: Av. Automovil Club Argentino 32, (X5172AAN) La Falda, Cordoba, Argentina.',
    'Telefono: +54 (03548) 425983 / 421121.',
    'Email: info@lafalda.gob.ar.',
  ].join('\n')
}

export async function getPersonTelegramDebtSummary(
  client: SupabaseClient,
  personId: number,
  tenantId: number
): Promise<{ personName: string; items: TelegramDebtSummaryItem[] }> {
  const [personResponse, relationResponse] = await Promise.all([
    client.from('person').select('full_name').eq('id', personId).maybeSingle(),
    client.from('debtor_person').select('debtor').eq('person', personId).eq('active', true),
  ])

  if (personResponse.error) {
    throw new Error(personResponse.error.message)
  }

  if (relationResponse.error) {
    throw new Error(relationResponse.error.message)
  }

  const debtorIds = Array.from(
    new Set(
      ((relationResponse.data as TelegramRow[] | null) ?? [])
        .map((row) => asNumber(row.debtor))
        .filter((debtorId) => debtorId > 0)
    )
  )

  const personName = asText((personResponse.data as TelegramRow | null)?.full_name) || 'la persona titular'

  if (debtorIds.length === 0) {
    return { personName, items: [] }
  }

  const debtorsResponse = await client
    .from('debtor')
    .select('id, identifier, type')
    .eq('tenant', tenantId)
    .in('id', debtorIds)

  if (debtorsResponse.error) {
    throw new Error(debtorsResponse.error.message)
  }

  const debtors = (debtorsResponse.data as TelegramRow[] | null) ?? []
  const authorizedDebtorIds = debtors.map((row) => asNumber(row.id)).filter((debtorId) => debtorId > 0)

  if (authorizedDebtorIds.length === 0) {
    return { personName, items: [] }
  }

  const typeIds = Array.from(
    new Set(debtors.map((row) => asNumber(row.type)).filter((typeId) => typeId > 0))
  )
  const [profileResponse, typeResponse] = await Promise.all([
    client
      .from('debtor_profile')
      .select('debtor, total_debt_amount, overdue_debt_amount, debt_count, overdue_debt_count, oldest_debt_days')
      .in('debtor', authorizedDebtorIds),
    typeIds.length > 0
      ? client.from('debtor_type').select('id, value').in('id', typeIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (profileResponse.error) {
    throw new Error(profileResponse.error.message)
  }

  if (typeResponse.error) {
    throw new Error(typeResponse.error.message)
  }

  const profilesByDebtorId = new Map<number, TelegramRow>(
    ((profileResponse.data as TelegramRow[] | null) ?? []).map((row) => [asNumber(row.debtor), row])
  )
  const typeLabels = new Map<number, string>(
    ((typeResponse.data as TelegramRow[] | null) ?? []).map((row) => [
      asNumber(row.id),
      asText(row.value),
    ])
  )

  return {
    personName,
    items: debtors.map((debtor) => {
      const profile = profilesByDebtorId.get(asNumber(debtor.id)) ?? {}

      return {
        identifier: asText(debtor.identifier) || `Objeto ${asNumber(debtor.id)}`,
        type: typeLabels.get(asNumber(debtor.type)) || 'Sin tipo',
        totalDebt: asNumber(profile.total_debt_amount),
        overdueDebt: asNumber(profile.overdue_debt_amount),
        debtCount: asNumber(profile.debt_count),
        overdueDebtCount: asNumber(profile.overdue_debt_count),
        oldestDebtDays: asNumber(profile.oldest_debt_days),
      }
    }),
  }
}

export async function sendTelegramMessage({
  botToken,
  chatId,
  text,
  replyKeyboard,
  forceReply = false,
}: {
  botToken: string
  chatId: string
  text: string
  replyKeyboard?: string[][]
  forceReply?: boolean
}) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: forceReply
        ? {
            force_reply: true,
            input_field_placeholder: 'Telefono y/o correo',
          }
        : replyKeyboard
        ? {
            keyboard: replyKeyboard.map((row) => row.map((buttonText) => ({ text: buttonText }))),
            resize_keyboard: true,
          }
        : undefined,
    }),
  })

  if (!response.ok) {
    throw new Error(`Telegram rechazo el mensaje (${response.status})`)
  }
}
