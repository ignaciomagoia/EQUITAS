import { describe, expect, it } from 'vitest'

import {
  buildEmailMessage,
  buildEmailSubject,
  buildMailtoUrl,
  buildWhatsAppMessage,
  buildWhatsAppUrl,
} from '@/components/people/person-contact-dialog'
import { mapPeopleFromRawData } from '@/lib/mappers/person-risk-mapper'
import type { RawPersonDataBundle } from '@/types/equitas-domain'

describe('mapeo de contactos de personas', () => {
  it('expone telefono, celular y email activos para mostrarlos bajo demanda', () => {
    const raw: RawPersonDataBundle = {
      people: [{ id: 21, full_name: 'Ana Perez', document_number: '20123456789' }],
      debtorProfilesDetail: [],
      debtorPeople: [],
      debtorContacts: [
        { id: 1, person: 21, type: 1, value: '3415550101', active: true },
        { id: 2, person: 21, type: 2, value: '3415550102', active: true },
        { id: 3, person: 21, type: 3, value: 'ANA@EXAMPLE.TEST', active: true },
        { id: 4, person: 21, type: 1, value: '3415550999', active: false },
      ],
      debts: [],
      debtorProfiles: [],
      debtors: [],
      warnings: [],
    }

    const { people } = mapPeopleFromRawData(raw)

    expect(people[0]).toMatchObject({
      id: '21',
      hasContact: true,
      contacts: [
        { channel: 'Telefono', value: '3415550101' },
        { channel: 'Celular', value: '3415550102' },
        { channel: 'Email', value: 'ANA@EXAMPLE.TEST' },
      ],
    })
  })
})

describe('mensaje asistido de WhatsApp', () => {
  it('prepara un enlace en formato internacional argentino sin enviar el mensaje', () => {
    const message = buildWhatsAppMessage({
      personName: 'Ana Perez',
      totalDebtAssociated: 150000,
      debtorIdentifiers: ['AG-1001', 'IN-2001'],
    })

    const url = buildWhatsAppUrl('0341 555-0102', message)

    expect(message).toMatch(/Saldo total informado: \$\s+150\.000/)
    expect(message).toContain('AG-1001, IN-2001')
    expect(url).toContain('https://wa.me/5493415550102?text=')
    expect(url).toContain(encodeURIComponent('Hola Ana Perez.'))
  })

  it('usa la institucion activa en Multiinstitucion sin cambiar el texto legado por defecto', () => {
    const message = buildWhatsAppMessage({
      personName: 'Ana Perez',
      totalDebtAssociated: 150000,
      debtorIdentifiers: ['ALU-2026-001'],
      institutionName: 'Universidad Demo',
    })

    expect(message).toContain('ALU-2026-001')
    expect(message).toContain('comuniquese con Universidad Demo.')
    expect(message).not.toContain('municipalidad')
  })
})

describe('correo asistido', () => {
  it('prepara asunto, cuerpo y enlace mailto sin enviar el correo', () => {
    const message = buildEmailMessage({
      personName: 'Ana Perez',
      totalDebtAssociated: 150000,
      debtorIdentifiers: ['AG-1001'],
    })
    const subject = buildEmailSubject()
    const url = buildMailtoUrl('ana@example.test', subject, message)

    expect(subject).toBe('Aviso informativo sobre obligaciones municipales')
    expect(message).toContain('Hola Ana Perez,')
    expect(message).toContain('AG-1001')
    expect(url).toContain('mailto:ana@example.test?subject=')
    expect(url).toContain(encodeURIComponent(subject))
  })

  it('personaliza asunto, firma y texto para la institucion activa', () => {
    const message = buildEmailMessage({
      personName: 'Ana Perez',
      totalDebtAssociated: 150000,
      debtorIdentifiers: ['ALU-2026-001'],
      institutionName: 'Universidad Demo',
    })
    const subject = buildEmailSubject('Universidad Demo')

    expect(subject).toBe('Aviso informativo sobre obligaciones - Universidad Demo')
    expect(message).toContain('comuniquese con Universidad Demo.')
    expect(message).toMatch(/\nUniversidad Demo$/)
  })
})
