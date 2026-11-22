import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createServerSupabaseClientMock } = vi.hoisted(() => ({
  createServerSupabaseClientMock: vi.fn(),
}))

vi.mock('@/lib/supabase-config', () => ({
  hasSupabaseCredentials: true,
}))

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: createServerSupabaseClientMock,
}))

import { loadRawDebtorData, loadRawDebtorDetailData } from '@/lib/data/raw-debtor-loader'
import type { RawRow } from '@/types/equitas-domain'
import { createPaginatedSupabase } from '../fixtures/paginated-supabase'

type SupabaseQueryResult = {
  data: unknown
  error: { message: string; code?: string | null } | null
}

function buildSupabaseClient(results: Record<string, SupabaseQueryResult>) {
  const tables = Object.fromEntries(Object.entries(results).map(([table, result]) => [table, (result.data ?? []) as RawRow[]]))
  const { client } = createPaginatedSupabase(tables, { fail: (request) => results[request.table]?.error ?? null })
  vi.spyOn(client, 'from')
  return client
}

describe('integracion simulada de lectura de objetos de deuda', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('integra filas validas de todas las consultas requeridas', async () => {
    const client = buildSupabaseClient({
      debtor: { data: [{ id: 1, external_id: 1001 }], error: null },
      debt: { data: [{ id: 11, debtor: 1 }], error: null },
    })
    createServerSupabaseClientMock.mockResolvedValue(client)

    const result = await loadRawDebtorData()

    expect(result.debtors).toEqual([{ id: 1, external_id: 1001 }])
    expect(result.debts).toEqual([{ id: 11, debtor: 1 }])
    expect(result.debtorTypes).toEqual([])
    expect(result.warnings).toEqual([])
    // Ocho tablas y una consulta terminal adicional por cada tabla con datos.
    expect(client.from).toHaveBeenCalledTimes(10)
  })

  it('acepta respuestas vacias como listados validos sin alerta', async () => {
    const client = buildSupabaseClient({})
    createServerSupabaseClientMock.mockResolvedValue(client)

    const result = await loadRawDebtorData()

    expect(result.debtors).toEqual([])
    expect(result.debts).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('omite deuda y relaciones en la carga resumida del dashboard', async () => {
    const client = buildSupabaseClient({
      debtor: { data: [{ id: 1, external_id: 1001 }], error: null },
      debtor_profile: { data: [{ id: 2, debtor: 1, total_debt_amount: 100 }], error: null },
    })
    createServerSupabaseClientMock.mockResolvedValue(client)

    const result = await loadRawDebtorData({
      includeDebtDetails: false,
      includeRelationships: false,
    })

    expect(result.debts).toEqual([])
    expect(result.debtorPeople).toEqual([])
    expect(result.debtorContacts).toEqual([])
    expect(client.from).not.toHaveBeenCalledWith('debt')
    expect(client.from).not.toHaveBeenCalledWith('debtor_person')
    expect(client.from).not.toHaveBeenCalledWith('debtor_contact')
  })

  it('carga solo las filas del objeto solicitado y sus relaciones', async () => {
    const { client, requests } = createPaginatedSupabase({
      debtor: [
        { id: 1, external_id: 1001 },
        { id: 2, external_id: 1002 },
      ],
      debt: [
        { id: 11, debtor: 1 },
        { id: 12, debtor: 2 },
      ],
      debtor_person: [
        { id: 21, debtor: 1, person: 31 },
        { id: 22, debtor: 2, person: 32 },
      ],
      person: [
        { id: 31, first_name: 'Ana' },
        { id: 32, first_name: 'Beto' },
      ],
      debtor_contact: [
        { id: 41, person: 31, value: 'ana@example.test' },
        { id: 42, person: 32, value: 'beto@example.test' },
      ],
      debtor_profile: [
        { id: 51, debtor: 1 },
        { id: 52, debtor: 2 },
      ],
      debtor_type: [{ id: 1, value: 'Agua' }],
      debt_status: [{ id: 1, value: 'Activa' }],
    })
    createServerSupabaseClientMock.mockResolvedValue(client)

    const result = await loadRawDebtorDetailData('1')

    expect(result.debtors).toEqual([{ id: 1, external_id: 1001 }])
    expect(result.debts).toEqual([{ id: 11, debtor: 1 }])
    expect(result.debtorPeople).toEqual([{ id: 21, debtor: 1, person: 31 }])
    expect(result.people).toEqual([{ id: 31, first_name: 'Ana' }])
    expect(result.debtorContacts).toEqual([{ id: 41, person: 31, value: 'ana@example.test' }])
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'debtor', filters: { id: 'eq.1' } }),
        expect.objectContaining({ table: 'debt', filters: { debtor: 'eq.1' } }),
        expect.objectContaining({ table: 'debtor_person', filters: { debtor: 'eq.1' } }),
        expect.objectContaining({ table: 'person', filters: { id: 'in.(31)' } }),
        expect.objectContaining({ table: 'debtor_contact', filters: { person: 'in.(31)' } }),
      ])
    )
  })

  it('convierte un error de conexion informado por Supabase en una alerta', async () => {
    const client = buildSupabaseClient({
      debt: {
        data: null,
        error: { message: 'FetchError: network connection failed' },
      },
    })
    createServerSupabaseClientMock.mockResolvedValue(client)

    const result = await loadRawDebtorData()

    expect(result.debts).toEqual([])
    expect(result.warnings).toContainEqual({
      table: 'debt',
      message: 'FetchError: network connection failed',
      code: undefined,
      needsSelectPolicy: false,
    })
  })

  it('identifica una denegacion por RLS para solicitar policy SELECT', async () => {
    const client = buildSupabaseClient({
      debtor_profile: {
        data: null,
        error: {
          code: '42501',
          message: 'new row violates row-level security policy',
        },
      },
    })
    createServerSupabaseClientMock.mockResolvedValue(client)

    const result = await loadRawDebtorData()

    expect(result.debtorProfiles).toEqual([])
    expect(result.warnings).toContainEqual({
      table: 'debtor_profile',
      code: '42501',
      message: 'new row violates row-level security policy',
      needsSelectPolicy: true,
    })
  })
})
