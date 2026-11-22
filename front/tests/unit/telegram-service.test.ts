import { describe, expect, it } from 'vitest'

import {
  buildTelegramDeepLink,
  formatMunicipalAttentionMessage,
  formatTelegramDebtMessages,
  hashTelegramAccessToken,
  TELEGRAM_MAIN_MENU,
} from '@/lib/telegram-service'

describe('enlaces de acceso de Telegram', () => {
  it('genera un enlace profundo con token opaco', () => {
    const link = buildTelegramDeepLink('Equitas_prueba_bot', 'token-seguro_123')

    expect(link).toBe('https://t.me/Equitas_prueba_bot?start=token-seguro_123')
    expect(hashTelegramAccessToken('token-seguro_123')).toHaveLength(64)
  })

  it('rechaza usuarios de bot invalidos', () => {
    expect(buildTelegramDeepLink('bot con espacios', 'token')).toBeNull()
  })
})

describe('resumen de obligaciones para Telegram', () => {
  it('incluye el detalle resumido de cada objeto asociado', () => {
    const messages = formatTelegramDebtMessages('Ana Perez', [
      {
        identifier: 'AG-1001',
        type: 'Agua',
        totalDebt: 150000,
        overdueDebt: 120000,
        debtCount: 3,
        overdueDebtCount: 2,
        oldestDebtDays: 60,
      },
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('Resumen de obligaciones de Ana Perez')
    expect(messages[0]).toContain('AG-1001 (Agua)')
    expect(messages[0]).toContain('Deudas: 3 | Vencidas: 2')
  })
})

describe('menu e informacion municipal de Telegram', () => {
  it('incluye las opciones de autogestion disponibles', () => {
    expect(TELEGRAM_MAIN_MENU.flat()).toEqual(
      expect.arrayContaining([
        'Consultar obligaciones',
        'Confirmar recepcion',
        'Actualizar datos',
        'Canales de atencion',
      ])
    )
  })

  it('muestra los canales oficiales configurados para La Falda', () => {
    const message = formatMunicipalAttentionMessage()

    expect(message).toContain('Municipio de La Falda')
    expect(message).toContain('Av. Automovil Club Argentino 32')
    expect(message).toContain('info@lafalda.gob.ar')
  })
})
