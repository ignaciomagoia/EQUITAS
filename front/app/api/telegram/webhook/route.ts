import {
  formatMunicipalAttentionMessage,
  formatTelegramDebtMessages,
  getPersonTelegramDebtSummary,
  getTelegramAdminClient,
  getTelegramConfiguration,
  hashTelegramAccessToken,
  isTelegramWebhookSecretValid,
  sendTelegramMessage,
  TELEGRAM_MAIN_MENU,
  TELEGRAM_ACCESS_LINK_TABLE,
} from '@/lib/telegram-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type TelegramMessage = {
  chat?: { id?: number }
  from?: { username?: string; is_bot?: boolean }
  text?: string
  reply_to_message?: {
    from?: { is_bot?: boolean }
    text?: string
  }
}

type TelegramUpdate = {
  message?: TelegramMessage
}

type LinkedTelegramAccess = {
  tenant: number
  person: number
}

function normalizeTelegramText(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

function isDataUpdateReply(message: TelegramMessage) {
  return Boolean(
    message.reply_to_message?.from?.is_bot &&
      message.reply_to_message.text?.startsWith('Actualizacion de datos (prueba)')
  )
}

async function getLinkedTelegramAccess({
  adminClient,
  chatId,
}: {
  adminClient: NonNullable<ReturnType<typeof getTelegramAdminClient>>
  chatId: string
}): Promise<LinkedTelegramAccess | null> {
  const linkedResponse = await adminClient
    .from(TELEGRAM_ACCESS_LINK_TABLE)
    .select('tenant, person')
    .eq('telegram_chat_id', chatId)
    .eq('active', true)
    .gte('expires_at', new Date().toISOString())
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (linkedResponse.error) {
    throw new Error(linkedResponse.error.message)
  }

  return (linkedResponse.data as LinkedTelegramAccess | null) ?? null
}

async function sendDebtSummary({
  chatId,
  personId,
  tenantId,
}: {
  chatId: string
  personId: number
  tenantId: number
}) {
  const configuration = getTelegramConfiguration()
  const adminClient = getTelegramAdminClient()

  if (!configuration || !adminClient) {
    throw new Error('La integracion de Telegram no esta configurada.')
  }

  const summary = await getPersonTelegramDebtSummary(adminClient, personId, tenantId)
  const messages = formatTelegramDebtMessages(summary.personName, summary.items)

  for (const [index, text] of messages.entries()) {
    await sendTelegramMessage({
      botToken: configuration.botToken,
      chatId,
      text,
      replyKeyboard: index === messages.length - 1 ? TELEGRAM_MAIN_MENU : undefined,
    })
  }
}

async function sendTelegramHelp(chatId: string) {
  const configuration = getTelegramConfiguration()

  if (!configuration) {
    throw new Error('La integracion de Telegram no esta configurada.')
  }

  await sendTelegramMessage({
    botToken: configuration.botToken,
    chatId,
    text: 'Para consultar sus obligaciones, abra el enlace personal recibido desde la municipalidad.',
  })
}

export async function POST(request: Request) {
  const configuration = getTelegramConfiguration()
  const adminClient = getTelegramAdminClient()

  if (!configuration || !adminClient) {
    return Response.json({ error: 'Telegram no configurado.' }, { status: 503 })
  }

  const webhookSecret = request.headers.get('x-telegram-bot-api-secret-token')
  if (!isTelegramWebhookSecretValid(configuration.webhookSecret, webhookSecret)) {
    return Response.json({ error: 'Webhook no autorizado.' }, { status: 401 })
  }

  let update: TelegramUpdate
  try {
    update = (await request.json()) as TelegramUpdate
  } catch {
    return Response.json({ error: 'Actualizacion no valida.' }, { status: 400 })
  }

  const message = update.message
  const chatId = message?.chat?.id ? String(message.chat.id) : ''
  const text = message?.text?.trim() ?? ''

  if (!message || !chatId || !text) {
    return Response.json({ ok: true })
  }

  const startMatch = text.match(/^\/start(?:\s+([A-Za-z0-9_-]+))?$/i)

  try {
    if (startMatch?.[1]) {
      const linkResponse = await adminClient
        .from(TELEGRAM_ACCESS_LINK_TABLE)
        .select('id, tenant, person, expires_at, telegram_chat_id')
        .eq('token_hash', hashTelegramAccessToken(startMatch[1]))
        .eq('active', true)
        .maybeSingle()

      if (linkResponse.error || !linkResponse.data) {
        await sendTelegramHelp(chatId)
        return Response.json({ ok: true })
      }

      const link = linkResponse.data as {
        id: number
        tenant: number
        person: number
        expires_at: string
        telegram_chat_id: number | null
      }

      if (new Date(link.expires_at).getTime() < Date.now()) {
        await sendTelegramMessage({
          botToken: configuration.botToken,
          chatId,
          text: 'El enlace recibido vencio. Solicite uno nuevo a la municipalidad.',
        })
        return Response.json({ ok: true })
      }

      if (link.telegram_chat_id && String(link.telegram_chat_id) !== chatId) {
        await sendTelegramMessage({
          botToken: configuration.botToken,
          chatId,
          text: 'El enlace ya fue utilizado. Solicite uno nuevo a la municipalidad.',
        })
        return Response.json({ ok: true })
      }

      const bindResponse = await adminClient
        .from(TELEGRAM_ACCESS_LINK_TABLE)
        .update({
          telegram_chat_id: chatId,
          telegram_username: message.from?.username ?? null,
          started_at: new Date().toISOString(),
        })
        .eq('id', link.id)

      if (bindResponse.error) {
        throw new Error(bindResponse.error.message)
      }

      await sendTelegramMessage({
        botToken: configuration.botToken,
        chatId,
        text: 'Acceso validado. A continuacion se muestra el resumen de obligaciones asociado.',
      })
      await sendDebtSummary({ chatId, personId: link.person, tenantId: link.tenant })
      return Response.json({ ok: true })
    }

    const linked = await getLinkedTelegramAccess({ adminClient, chatId })

    if (!linked) {
      await sendTelegramHelp(chatId)
      return Response.json({ ok: true })
    }

    const normalizedText = normalizeTelegramText(text)

    if (isDataUpdateReply(message)) {
      await sendTelegramMessage({
        botToken: configuration.botToken,
        chatId,
        text: 'Gracias. Recibimos los datos informados solo para esta prueba. Todavia no se guardaron ni modificaron los datos oficiales.',
        replyKeyboard: TELEGRAM_MAIN_MENU,
      })
      return Response.json({ ok: true })
    }

    if (text === '/deuda' || normalizedText === 'consultar obligaciones') {
      await sendDebtSummary({ chatId, personId: linked.person, tenantId: linked.tenant })
      return Response.json({ ok: true })
    }

    if (normalizedText === 'confirmar recepcion') {
      await sendTelegramMessage({
        botToken: configuration.botToken,
        chatId,
        text: 'Gracias por confirmar la lectura de este aviso. Esta accion todavia no crea un tramite ni modifica su situacion ante la municipalidad.',
        replyKeyboard: TELEGRAM_MAIN_MENU,
      })
      return Response.json({ ok: true })
    }

    if (normalizedText === 'actualizar datos') {
      await sendTelegramMessage({
        botToken: configuration.botToken,
        chatId,
        text: 'Actualizacion de datos (prueba)\n\nResponda a este mensaje con su telefono y/o correo actualizado. Por ahora, la informacion no se guarda ni reemplaza sus datos oficiales.',
        forceReply: true,
      })
      return Response.json({ ok: true })
    }

    if (normalizedText === 'solicitar contacto') {
      await sendTelegramMessage({
        botToken: configuration.botToken,
        chatId,
        text: `La solicitud automatica de contacto estara disponible proximamente. Mientras tanto, comuniquese por los canales oficiales:\n\n${formatMunicipalAttentionMessage()}`,
        replyKeyboard: TELEGRAM_MAIN_MENU,
      })
      return Response.json({ ok: true })
    }

    if (normalizedText === 'canales de atencion') {
      await sendTelegramMessage({
        botToken: configuration.botToken,
        chatId,
        text: formatMunicipalAttentionMessage(),
        replyKeyboard: TELEGRAM_MAIN_MENU,
      })
      return Response.json({ ok: true })
    }

    if (normalizedText === 'informar inconveniente') {
      await sendTelegramMessage({
        botToken: configuration.botToken,
        chatId,
        text: `Si no reconoce una obligacion o necesita informar un inconveniente, comuniquese con la municipalidad para su revision.\n\n${formatMunicipalAttentionMessage()}`,
        replyKeyboard: TELEGRAM_MAIN_MENU,
      })
      return Response.json({ ok: true })
    }

    await sendTelegramMessage({
      botToken: configuration.botToken,
      chatId,
      text: 'Seleccione una opcion del menu para consultar sus obligaciones o comunicarse con la municipalidad.',
      replyKeyboard: TELEGRAM_MAIN_MENU,
    })
    return Response.json({ ok: true })
  } catch (error) {
    console.error('No se pudo procesar la actualizacion de Telegram.', error)
    return Response.json({ error: 'No se pudo procesar la actualizacion.' }, { status: 500 })
  }
}
