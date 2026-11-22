import { loadAllTableRows } from '@/lib/data/paginated-table-reader'
import { EQUITAS_TABLE_NAMES } from '@/lib/data/table-names'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import type { DataWarning, RawDebtorDataBundle } from '@/types/equitas-domain'

type RawDebtorDataOptions = {
  includeDebtDetails?: boolean
  includeRelationships?: boolean
}

// Punto de entrada de datos crudos para objetos de deuda.
// Los listados usan los agregados del perfil; el detalle conserva las deudas individuales.
export async function loadRawDebtorData({
  includeDebtDetails = true,
  includeRelationships = true,
}: RawDebtorDataOptions = {}): Promise<RawDebtorDataBundle> {
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
  const warnings = results
    .map(([, result]) => result.warning)
    .filter((warning): warning is DataWarning => Boolean(warning))

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
