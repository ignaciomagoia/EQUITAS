import {
  loadAllTableRows,
  loadFilteredTableRows,
} from '@/lib/data/paginated-table-reader'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import type { DataWarning, RawDebtorDataBundle, RawPersonDataBundle, RawRow } from '@/types/equitas-domain'

type RawDebtorDataOptions = {
  includeDebtDetails?: boolean
  includeRelationships?: boolean
}

function collectWarnings(results: Array<{ warning: DataWarning | null }>) {
  return results
    .map((result) => result.warning)
    .filter((warning): warning is DataWarning => Boolean(warning))
}

function uniqueIds(rows: RawRow[], key: string) {
  return [...new Set(rows.map((row) => row[key]).filter((value): value is string | number =>
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.trim().length > 0)
  ))]
}

function decorateMultiContacts(contacts: RawRow[], contactTypes: RawRow[]) {
  const labelsById = new Map(
    contactTypes.map((type) => [String(type.id), String(type.name ?? type.code ?? 'Contacto')])
  )

  return contacts.map((contact) => ({
    ...contact,
    channel: labelsById.get(String(contact.contact_type_id)) ?? 'Contacto',
    type: labelsById.get(String(contact.contact_type_id)) ?? 'Contacto',
  }))
}

function adaptObjectTypes(rows: RawRow[]) {
  return rows.map((row) => ({ ...row, value: row.name ?? row.code ?? row.id }))
}

function adaptDebtStatuses(rows: RawRow[]) {
  return rows.map((row) => ({ ...row, value: row.name ?? row.code ?? row.id }))
}

function adaptDebtors(rows: RawRow[]) {
  return rows.map((row) => ({ ...row, debtor_type_id: row.object_type_id }))
}

function adaptDebts(rows: RawRow[]) {
  return rows.map((row) => ({
    ...row,
    updated_amount: row.updated_amount ?? row.current_amount,
    debt_status_id: row.status_id,
  }))
}

export async function loadMultiRawDebtorData({
  includeDebtDetails = true,
  includeRelationships = true,
}: RawDebtorDataOptions = {}): Promise<RawDebtorDataBundle> {
  const supabase = await createServerSupabaseClient('multi')
  const [debtorsResult, objectTypesResult, profilesResult, debtsResult, statusesResult, relationsResult, peopleResult, contactsResult, contactTypesResult] =
    await Promise.all([
      loadAllTableRows('debtor', supabase, 'multi'),
      loadAllTableRows('institution_object_type', supabase, 'multi'),
      loadAllTableRows('debtor_profile', supabase, 'multi'),
      includeDebtDetails ? loadAllTableRows('debt', supabase, 'multi') : Promise.resolve({ rows: [], warning: null }),
      includeDebtDetails ? loadAllTableRows('institution_debt_status', supabase, 'multi') : Promise.resolve({ rows: [], warning: null }),
      includeRelationships ? loadAllTableRows('debtor_person', supabase, 'multi') : Promise.resolve({ rows: [], warning: null }),
      includeRelationships ? loadAllTableRows('person', supabase, 'multi') : Promise.resolve({ rows: [], warning: null }),
      includeRelationships ? loadAllTableRows('debtor_contact', supabase, 'multi') : Promise.resolve({ rows: [], warning: null }),
      includeRelationships ? loadAllTableRows('contact_type', supabase, 'multi') : Promise.resolve({ rows: [], warning: null }),
    ])
  const results = [
    debtorsResult, objectTypesResult, profilesResult, debtsResult, statusesResult,
    relationsResult, peopleResult, contactsResult, contactTypesResult,
  ]

  return {
    debtors: adaptDebtors(debtorsResult.rows),
    debtorTypes: adaptObjectTypes(objectTypesResult.rows),
    debts: adaptDebts(debtsResult.rows),
    debtStatuses: adaptDebtStatuses(statusesResult.rows),
    debtorPeople: relationsResult.rows,
    people: peopleResult.rows,
    debtorContacts: decorateMultiContacts(contactsResult.rows, contactTypesResult.rows),
    debtorProfiles: profilesResult.rows,
    warnings: collectWarnings(results),
  }
}

export async function loadMultiRawDebtorDetailData(debtorId: string): Promise<RawDebtorDataBundle> {
  const supabase = await createServerSupabaseClient('multi')
  const [debtorResult, objectTypesResult, debtsResult, statusesResult, relationsResult, profileResult, contactTypesResult] =
    await Promise.all([
      loadFilteredTableRows('debtor', { id: debtorId }, supabase, 'multi'),
      loadAllTableRows('institution_object_type', supabase, 'multi'),
      loadFilteredTableRows('debt', { debtor_id: debtorId }, supabase, 'multi'),
      loadAllTableRows('institution_debt_status', supabase, 'multi'),
      loadFilteredTableRows('debtor_person', { debtor_id: debtorId }, supabase, 'multi'),
      loadFilteredTableRows('debtor_profile', { debtor_id: debtorId }, supabase, 'multi'),
      loadAllTableRows('contact_type', supabase, 'multi'),
    ])
  const personIds = uniqueIds(relationsResult.rows, 'person_id')
  const [peopleResult, contactsResult] = await Promise.all([
    loadFilteredTableRows('person', { id: personIds }, supabase, 'multi'),
    loadFilteredTableRows('debtor_contact', { person_id: personIds }, supabase, 'multi'),
  ])
  const results = [
    debtorResult, objectTypesResult, debtsResult, statusesResult, relationsResult,
    profileResult, contactTypesResult, peopleResult, contactsResult,
  ]

  return {
    debtors: adaptDebtors(debtorResult.rows),
    debtorTypes: adaptObjectTypes(objectTypesResult.rows),
    debts: adaptDebts(debtsResult.rows),
    debtStatuses: adaptDebtStatuses(statusesResult.rows),
    debtorPeople: relationsResult.rows,
    people: peopleResult.rows,
    debtorContacts: decorateMultiContacts(contactsResult.rows, contactTypesResult.rows),
    debtorProfiles: profileResult.rows,
    warnings: collectWarnings(results),
  }
}

export async function loadMultiRawPeopleData(): Promise<RawPersonDataBundle> {
  const supabase = await createServerSupabaseClient('multi')
  const [peopleResult, detailResult, relationsResult, contactsResult, profilesResult, debtorsResult, contactTypesResult] =
    await Promise.all([
      loadAllTableRows('person', supabase, 'multi'),
      loadAllTableRows('debtor_profile_detail', supabase, 'multi'),
      loadAllTableRows('debtor_person', supabase, 'multi'),
      loadAllTableRows('debtor_contact', supabase, 'multi'),
      loadAllTableRows('debtor_profile', supabase, 'multi'),
      loadAllTableRows('debtor', supabase, 'multi'),
      loadAllTableRows('contact_type', supabase, 'multi'),
    ])
  const results = [
    peopleResult, detailResult, relationsResult, contactsResult, profilesResult, debtorsResult, contactTypesResult,
  ]

  return {
    people: peopleResult.rows,
    debtorProfilesDetail: detailResult.rows,
    debtorPeople: relationsResult.rows,
    debtorContacts: decorateMultiContacts(contactsResult.rows, contactTypesResult.rows),
    debts: [],
    debtorProfiles: profilesResult.rows,
    debtors: adaptDebtors(debtorsResult.rows),
    warnings: collectWarnings(results),
  }
}
