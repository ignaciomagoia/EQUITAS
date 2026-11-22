import {
  parseBooleanFromUnknown,
  rowHasCandidateKey,
  selectTextFromRow,
  selectValueFromRow,
  stringifyUnknownValue,
} from '@/lib/parsers/generic-value-selector'
import { parseNumericValue, selectNumericValueFromRow } from '@/lib/parsers/numeric-value-parser'
import { clampRiskScore, mapRiskLevel } from '@/lib/services/debtor-risk-calculator'
import type {
  PeopleDashboardSummary,
  PersonContactItem,
  PersonIndividualRiskLevel,
  PersonListItem,
  RawPersonDataBundle,
} from '@/types/equitas-domain'

function clampRiskValue(value: number) {
  return clampRiskScore(value)
}

function resolvePersonContactChannel(contactRow: Record<string, unknown>, value: string) {
  const contactType = stringifyUnknownValue(
    selectValueFromRow(contactRow, ['type', 'contact_type_id', 'type_id'])
  )

  if (contactType === '1') {
    return 'Telefono'
  }

  if (contactType === '2') {
    return 'Celular'
  }

  if (contactType === '3') {
    return 'Email'
  }

  const explicitChannel = selectTextFromRow(contactRow, [
    'channel',
    'contact_channel',
    'contact_type_name',
    'type_name',
  ]).trim()
  const normalizedChannel = explicitChannel.toLowerCase()

  if (normalizedChannel.includes('mail') || value.includes('@')) {
    return 'Email'
  }

  if (normalizedChannel.includes('cel') || normalizedChannel.includes('mobile')) {
    return 'Celular'
  }

  if (normalizedChannel.includes('tel') || normalizedChannel.includes('phone')) {
    return 'Telefono'
  }

  return 'Otro canal'
}

// Convierte risk_value individual (escala 0-100) al nivel cualitativo de negocio.
export function mapRiskValueToIndividualRiskLevel(
  riskValue: number
): PersonIndividualRiskLevel {
  return mapRiskLevel(riskValue)
}

function buildPeopleDashboardSummary(people: PersonListItem[]): PeopleDashboardSummary {
  const lowRiskCount = people.filter((person) => person.individualRisk === 'BAJO').length
  const mediumRiskCount = people.filter((person) => person.individualRisk === 'MEDIO').length
  const highRiskCount = people.filter((person) => person.individualRisk === 'ALTO').length
  const withoutContactCount = people.filter((person) => !person.hasContact).length

  return {
    totalPeople: people.length,
    lowRiskCount,
    mediumRiskCount,
    highRiskCount,
    withoutContactCount,
    individualRiskDistribution: [
      { label: 'Bajo', value: lowRiskCount },
      { label: 'Medio', value: mediumRiskCount },
      { label: 'Alto', value: highRiskCount },
    ],
    topPeopleByRiskValue: [...people]
      .sort((a, b) => {
        if (b.riskValue !== a.riskValue) {
          return b.riskValue - a.riskValue
        }

        if (b.totalDebtAssociated !== a.totalDebtAssociated) {
          return b.totalDebtAssociated - a.totalDebtAssociated
        }

        return a.name.localeCompare(b.name)
      })
      .slice(0, 5)
      .map((person) => ({
        id: person.id,
        name: person.name,
        document: person.document,
        riskValue: person.riskValue,
        individualRisk: person.individualRisk,
        debtorsCount: person.debtorsCount,
        hasContact: person.hasContact,
      })),
  }
}

// Arma el universo de personas con riesgo individual y vinculos reales contra objetos de deuda.
export function mapPeopleFromRawData(raw: RawPersonDataBundle): {
  people: PersonListItem[]
  dashboard: PeopleDashboardSummary
} {
  const debtorIdentifierById = new Map<string, string>()
  for (const debtorRow of raw.debtors) {
    const debtorId = stringifyUnknownValue(
      selectValueFromRow(debtorRow, ['id', 'debtor_id', 'debtorid'])
    )

    if (!debtorId) {
      continue
    }

    const identifier =
      selectTextFromRow(debtorRow, [
        'identifier',
        'code',
        'account_number',
        'domain',
        'external_id',
        'name',
      ]) || `OBJ-${debtorId}`

    debtorIdentifierById.set(debtorId, identifier)
  }

  const debtTotalByDebtor = new Map<string, number>()
  for (const profileRow of raw.debtorProfiles) {
    const debtorId = stringifyUnknownValue(
      selectValueFromRow(profileRow, ['debtor_id', 'id_debtor', 'debtorid', 'debtor'])
    )

    if (!debtorId || !rowHasCandidateKey(profileRow, [
      'total_debt_amount',
      'total_debt',
      'debt_total',
      'amount_total',
    ])) {
      continue
    }

    debtTotalByDebtor.set(
      debtorId,
      selectNumericValueFromRow(profileRow, [
        'total_debt_amount',
        'total_debt',
        'debt_total',
        'amount_total',
      ])
    )
  }

  for (const debtRow of raw.debts) {
    const debtorId = stringifyUnknownValue(
      selectValueFromRow(debtRow, ['debtor_id', 'id_debtor', 'debtorid', 'debtor'])
    )

    if (!debtorId) {
      continue
    }

    const updatedAmount =
      selectNumericValueFromRow(debtRow, [
        'updated_amount',
        'amount_updated',
        'total_amount',
        'amount_due',
        'monto_actualizado',
      ]) ||
      selectNumericValueFromRow(debtRow, [
        'original_amount',
        'amount_original',
        'capital_amount',
        'amount',
        'monto_original',
      ])

    if (!debtTotalByDebtor.has(debtorId)) {
      debtTotalByDebtor.set(debtorId, (debtTotalByDebtor.get(debtorId) ?? 0) + updatedAmount)
    }
  }

  const riskValueByPerson = new Map<string, number>()
  for (const detailRow of raw.debtorProfilesDetail) {
    const personId = stringifyUnknownValue(
      selectValueFromRow(detailRow, ['person', 'person_id', 'id_person'])
    )

    if (!personId) {
      continue
    }

    const riskValueRaw = selectNumericValueFromRow(detailRow, [
      'risk_value',
      'risk',
      'value',
      'score',
    ])
    const riskValue = clampRiskValue(parseNumericValue(riskValueRaw))
    const currentValue = riskValueByPerson.get(personId)

    // Si hay varios detalles de perfil, usamos el valor maximo para no subestimar el riesgo.
    if (currentValue === undefined || riskValue > currentValue) {
      riskValueByPerson.set(personId, riskValue)
    }
  }

  const debtorIdsByPerson = new Map<string, Set<string>>()
  for (const relationRow of raw.debtorPeople) {
    const debtorId = stringifyUnknownValue(
      selectValueFromRow(relationRow, ['debtor_id', 'id_debtor', 'debtorid', 'debtor'])
    )
    const personId = stringifyUnknownValue(
      selectValueFromRow(relationRow, ['person_id', 'id_person', 'person'])
    )

    if (!debtorId || !personId) {
      continue
    }

    const hasActiveColumn = rowHasCandidateKey(relationRow, [
      'active',
      'is_active',
      'enabled',
      'valid',
    ])
    const relationIsActive = hasActiveColumn
      ? parseBooleanFromUnknown(
          selectValueFromRow(relationRow, ['active', 'is_active', 'enabled', 'valid'])
        )
      : true

    if (!relationIsActive) {
      continue
    }

    const current = debtorIdsByPerson.get(personId) ?? new Set<string>()
    current.add(debtorId)
    debtorIdsByPerson.set(personId, current)
  }

  const contactsByPerson = new Map<string, PersonContactItem[]>()
  for (const contactRow of raw.debtorContacts) {
    const personId = stringifyUnknownValue(
      selectValueFromRow(contactRow, ['person', 'person_id', 'id_person'])
    )

    if (!personId) {
      continue
    }

    const value = selectTextFromRow(contactRow, [
      'value',
      'contact_value',
      'contact',
      'phone',
      'email',
      'phone_number',
      'mobile',
      'whatsapp',
    ]).trim()

    if (!value) {
      continue
    }

    const hasActiveColumn = rowHasCandidateKey(contactRow, [
      'active',
      'is_active',
      'is_available',
      'available',
      'valid',
    ])
    const contactIsActive = hasActiveColumn
      ? parseBooleanFromUnknown(
          selectValueFromRow(contactRow, [
            'active',
            'is_active',
            'is_available',
            'available',
            'valid',
          ])
        )
      : true

    if (contactIsActive) {
      const channel = resolvePersonContactChannel(contactRow, value)
      const currentContacts = contactsByPerson.get(personId) ?? []

      if (!currentContacts.some((contact) => contact.channel === channel && contact.value === value)) {
        currentContacts.push({ channel, value })
      }

      contactsByPerson.set(personId, currentContacts)
    }
  }

  const people: PersonListItem[] = []
  for (const personRow of raw.people) {
    const personId = stringifyUnknownValue(selectValueFromRow(personRow, ['id', 'person_id']))

    if (!personId) {
      continue
    }

    const firstName = selectTextFromRow(personRow, ['first_name', 'name'])
    const lastName = selectTextFromRow(personRow, ['last_name', 'surname'])
    const fullName =
      selectTextFromRow(personRow, ['full_name', 'display_name']) ||
      `${firstName} ${lastName}`.trim() ||
      `Persona ${personId}`
    const document =
      selectTextFromRow(personRow, ['document_number', 'document', 'dni', 'tax_id']) ||
      'Sin documento'
    const riskValue = clampRiskValue(riskValueByPerson.get(personId) ?? 0)
    const individualRisk = mapRiskValueToIndividualRiskLevel(riskValue)
    const debtorIds = Array.from(debtorIdsByPerson.get(personId) ?? new Set<string>())
    const debtorIdentifiers = debtorIds.map(
      (debtorId) => debtorIdentifierById.get(debtorId) ?? `OBJ-${debtorId}`
    )
    const totalDebtAssociated = debtorIds.reduce(
      (acc, debtorId) => acc + (debtTotalByDebtor.get(debtorId) ?? 0),
      0
    )
    const contacts = contactsByPerson.get(personId) ?? []

    people.push({
      id: personId,
      name: fullName,
      document,
      individualRisk,
      riskValue,
      debtorsCount: debtorIds.length,
      hasContact: contacts.length > 0,
      contacts,
      totalDebtAssociated,
      debtorIds,
      debtorIdentifiers,
    })
  }

  people.sort((a, b) => {
    if (b.riskValue !== a.riskValue) {
      return b.riskValue - a.riskValue
    }

    if (b.totalDebtAssociated !== a.totalDebtAssociated) {
      return b.totalDebtAssociated - a.totalDebtAssociated
    }

    return a.name.localeCompare(b.name)
  })

  return {
    people,
    dashboard: buildPeopleDashboardSummary(people),
  }
}
