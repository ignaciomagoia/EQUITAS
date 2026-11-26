import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ values: [] as unknown[] }))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: <T,>(initial: T) => [(state.values.length ? state.values.shift() : initial) as T, vi.fn()] as const,
    useEffect: () => undefined,
    useId: () => 'contact-dialog-title',
  }
})
vi.mock('@/components/auth/auth-provider', () => ({
  useAuthState: () => ({ source: 'multi', tenant: { name: 'Universidad Demo' } }),
}))

import { PersonContactDialog } from '@/components/people/person-contact-dialog'

describe('diÃ¡logo abierto de contacto institucional', () => {
  beforeEach(() => {
    state.values = [
      true,
      { channel: 'whatsapp', contact: { channel: 'Celular', value: '3511234567' } },
      '', 'Mensaje institucional preparado', null, false, null, null, false,
    ]
  })

  it('ofrece borradores para WhatsApp y correo sin mostrar Telegram en MultiinstituciÃ³n', () => {
    const html = renderToStaticMarkup(createElement(PersonContactDialog, {
      personId: 'person-1', personName: 'Ana Demo',
      contacts: [
        { channel: 'Celular', value: '3511234567' },
        { channel: 'Email', value: 'ana@example.test' },
      ],
      totalDebtAssociated: 1500,
      debtorIdentifiers: ['ALU-2026-001', 'ALU-2026-002'],
    }))

    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('WhatsApp')
    expect(html).toContain('Mensaje institucional preparado')
    expect(html).toContain('https://wa.me/5493511234567')
    expect(html).not.toContain('Asistente de Telegram')
  })
})
