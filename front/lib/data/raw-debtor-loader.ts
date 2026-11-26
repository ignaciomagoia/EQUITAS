import {
  loadAllTableRows,
  loadFilteredTableRows,
} from '@/lib/data/paginated-table-reader'
import { EQUITAS_TABLE_NAMES } from '@/lib/data/table-names'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { getCurrentSupabaseSource } from '@/lib/auth/auth-source-server'
import {
  loadMultiRawDebtorData,
  loadMultiRawDebtorDetailData,
} from '@/lib/data/multiinstitution-raw-loader'
import type { DataWarning, RawDebtorDataBundle, RawRow } from '@/types/equitas-domain'

type RawDebtorDataOptions = {
  includeDebtDetails?: boolean
  includeRelationships?: boolean
}

function collectWarnings(results: Array<{ warning: DataWarning | null }>) {
  return results
    .map((result) => result.warning)
    .filter((warning): warning is DataWarning => Boolean(warning))
}

function uniqueFilterValues(rows: RawRow[], key: string) {
  const values = new Set<string | number>()

  for (const row of rows) {
    const value = row[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      values.add(value)
    }
    if (typeof value === 'string' && value.trim()) {
      values.add(value.trim())
    }
  }

  return [...values]
}

// Punto de entrada de datos crudos para objetos de deuda.
// Los listados usan los agregados del perfil; el detalle conserva las deudas individuales.
export async function loadRawDebtorData({
  includeDebtDetails = true,
  includeRelationships = true,
}: RawDebtorDataOptions = {}): Promise<RawDebtorDataBundle> {
  if ((await getCurrentSupabaseSource()) === 'multi') {
    return loadMultiRawDebtorData({ includeDebtDetails, includeRelationships })
  }

  const supabase = await createServerSupabaseClient()
  const tables = [
    EQUITAS_TABLE_NAMES.debtor,
    EQUITAS_TABLE_NAMES.debtorType,
    ...(includeDebtDetails
      ? [EQUITAS_TABLE_NAMES.debt, EQUITAS_TABLE_NAMES.debtStatus]
      : []),
    ...(includeRelationships
      ? [
          EQUITAS_TABLE_NAMES.debtorPerson,
          EQUITAS_TABLE_NAMES.person,
          EQUITAS_TABLE_NAMES.debtorContact,
        ]
      : []),
    EQUITAS_TABLE_NAMES.debtorProfile,
  ] as const
  const results = await Promise.all(
    tables.map(async (table) => [table, await loadAllTableRows(table, supabase)] as const)
  )
  const rowsByTable = new Map(results)
  const warnings = collectWarnings(results.map(([, result]) => result))

  return {
    debtors: rowsByTable.get(EQUITAS_TABLE_NAMES.debtor)?.rows ?? [],
    debtorTypes: rowsByTable.get(EQUITAS_TABLE_NAMES.debtorType)?.rows ?? [],
    debts: rowsByTable.get(EQUITAS_TABLE_NAMES.debt)?.rows ?? [],
    debtStatuses: rowsByTable.get(EQUITAS_TABLE_NAMES.debtStatus)?.rows ?? [],
    debtorPeople: rowsByTable.get(EQUITAS_TABLE_NAMES.debtorPerson)?.rows ?? [],
    people: rowsByTable.get(EQUITAS_TABLE_NAMES.person)?.rows ?? [],
    debtorContacts: rowsByTable.get(EQUITAS_TABLE_NAMES.debtorContact)?.rows ?? [],
    debtorProfiles: rowsByTable.get(EQUITAS_TABLE_NAMES.debtorProfile)?.rows ?? [],
    warnings,
  }
}

// Carga solamente las filas necesarias para un objeto. Evita descargar todo el padron para abrir su detalle.
export async function loadRawDebtorDetailData(debtorId: string): Promise<RawDebtorDataBundle> {
  if ((await getCurrentSupabaseSource()) === 'multi') {
    return loadMultiRawDebtorDetailData(debtorId)
  }

  const supabase = await createServerSupabaseClient()
  const [debtorResult, debtorTypesResult, debtsResult, debtStatusesResult, debtorPeopleResult, profileResult] =
    await Promise.all([
      loadFilteredTableRows(EQUITAS_TABLE_NAMES.debtor, { id: debtorId }, supabase),
      loadAllTableRows(EQUITAS_TABLE_NAMES.debtorType, supabase),
      loadFilteredTableRows(EQUITAS_TABLE_NAMES.debt, { debtor: debtorId }, supabase),
      loadAllTableRows(EQUITAS_TABLE_NAMES.debtStatus, supabase),
      loadFilteredTableRows(EQUITAS_TABLE_NAMES.debtorPerson, { debtor: debtorId }, supabase),
      loadFilteredTableRows(EQUITAS_TABLE_NAMES.debtorProfile, { debtor: debtorId }, supabase),
    ])

  const personIds = uniqueFilterValues(debtorPeopleResult.rows, 'person')
  const [peopleResult, debtorContactsResult] = await Promise.all([
    loadFilteredTableRows(EQUITAS_TABLE_NAMES.person, { id: personIds }, supabase),
    loadFilteredTableRows(EQUITAS_TABLE_NAMES.debtorContact, { person: personIds }, supabase),
  ])
  const results = [
    debtorResult,
    debtorTypesResult,
    debtsResult,
    debtStatusesResult,
    debtorPeopleResult,
    peopleResult,
    debtorContactsResult,
    profileResult,
  ]

  return {
    debtors: debtorResult.rows,
    debtorTypes: debtorTypesResult.rows,
    debts: debtsResult.rows,
    debtStatuses: debtStatusesResult.rows,
    debtorPeople: debtorPeopleResult.rows,
    people: peopleResult.rows,
    debtorContacts: debtorContactsResult.rows,
    debtorProfiles: profileResult.rows,
    warnings: collectWarnings(results),
  }
}
