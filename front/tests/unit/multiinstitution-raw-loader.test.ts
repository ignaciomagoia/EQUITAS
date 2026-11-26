import { beforeEach, describe, expect, it, vi } from 'vitest'

const data = vi.hoisted(() => ({
  tables: new Map<string, Array<Record<string, unknown>>>(),
}))

vi.mock('@/lib/supabase-server', () => ({ createServerSupabaseClient: vi.fn(async () => ({ source: 'multi' })) }))
vi.mock('@/lib/data/paginated-table-reader', () => ({
  loadAllTableRows: vi.fn(async (table: string) => ({ rows: data.tables.get(table) ?? [], warning: null })),
  loadFilteredTableRows: vi.fn(async (table: string, filters: Record<string, unknown>) => ({
    rows: (data.tables.get(table) ?? []).filter((row) => Object.entries(filters).some(([key, value]) => {
      if (Array.isArray(value)) return value.map(String).includes(String(row[key]))
      return String(row[key]) === String(value)
    })), warning: null,
  })),
}))

import {
  loadMultiRawDebtorData,
  loadMultiRawDebtorDetailData,
  loadMultiRawPeopleData,
} from '@/lib/data/multiinstitution-raw-loader'

function installFixture() {
  data.tables = new Map([
    ['debtor', [{ id: 1, object_type_id: 2, description: 'Objeto Demo' }]],
    ['institution_object_type', [{ id: 2, code: 'ALUMNO', name: 'Alumno' }]],
    ['debtor_profile', [{ debtor_id: 1, risk_level: 'ALTO' }]],
    ['debt', [{ id: 5, debtor_id: 1, status_id: 3, current_amount: 900, original_amount: 800 }]],
    ['institution_debt_status', [{ id: 3, code: 'VENCIDA', name: 'Vencida' }]],
    ['debtor_person', [{ debtor_id: 1, person_id: 8 }]],
    ['person', [{ id: 8, full_name: 'Ana Demo' }]],
    ['debtor_contact', [{ person_id: 8, contact_type_id: 4, value: 'ana@example.test' }]],
    ['contact_type', [{ id: 4, code: 'EMAIL', name: 'Email' }]],
    ['debtor_profile_detail', [{ debtor_id: 1, person_id: 8, risk_value: 80 }]],
  ])
}

beforeEach(installFixture)

describe('cargadores del dominio MultiinstituciÃ³n', () => {
  it('adapta el conjunto operativo sin mezclar nombres del esquema legado', async () => {
    const result = await loadMultiRawDebtorData()

    expect(result.debtors).toEqual([expect.objectContaining({ id: 1, debtor_type_id: 2 })])
    expect(result.debts).toEqual([expect.objectContaining({ updated_amount: 900, debt_status_id: 3 })])
    expect(result.debtStatuses).toEqual([expect.objectContaining({ code: 'VENCIDA', value: 'Vencida' })])
    expect(result.debtorContacts).toEqual([expect.objectContaining({ channel: 'Email', type: 'Email' })])
    expect(result.debtorTypes).toEqual([expect.objectContaining({ value: 'Alumno' })])
  })

  it('carga solamente las relaciones del objeto solicitado para su detalle', async () => {
    const result = await loadMultiRawDebtorDetailData('1')

    expect(result.debtors).toHaveLength(1)
    expect(result.debts).toHaveLength(1)
    expect(result.people).toEqual([expect.objectContaining({ id: 8, full_name: 'Ana Demo' })])
    expect(result.debtorContacts).toEqual([expect.objectContaining({ value: 'ana@example.test', channel: 'Email' })])
  })

  it('entrega el insumo de personas con perfiles y contactos institucionales', async () => {
    const result = await loadMultiRawPeopleData()

    expect(result.people).toHaveLength(1)
    expect(result.debtorProfilesDetail).toEqual([expect.objectContaining({ risk_value: 80 })])
    expect(result.debtorContacts).toEqual([expect.objectContaining({ channel: 'Email' })])
    expect(result.debts).toEqual([])
  })
})
