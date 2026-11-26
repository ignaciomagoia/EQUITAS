import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  multiList: vi.fn(async () => ({ debtors: [{ id: 7 }], warnings: [] })),
  multiDetail: vi.fn(async () => ({ debtors: [{ id: 8 }], warnings: [] })),
}))

vi.mock('@/lib/auth/auth-source-server', () => ({ getCurrentSupabaseSource: vi.fn(async () => 'multi') }))
vi.mock('@/lib/data/multiinstitution-raw-loader', () => ({
  loadMultiRawDebtorData: state.multiList,
  loadMultiRawDebtorDetailData: state.multiDetail,
}))

import { loadRawDebtorData, loadRawDebtorDetailData } from '@/lib/data/raw-debtor-loader'

describe('seleccion de fuente de objetos de deuda', () => {
  it('deriva listado y detalle desde Multiinstitucion cuando la sesion lo indica', async () => {
    await expect(loadRawDebtorData({ includeDebtDetails: false })).resolves.toMatchObject({ debtors: [{ id: 7 }] })
    await expect(loadRawDebtorDetailData('8')).resolves.toMatchObject({ debtors: [{ id: 8 }] })

    expect(state.multiList).toHaveBeenCalledWith({ includeDebtDetails: false, includeRelationships: true })
    expect(state.multiDetail).toHaveBeenCalledWith('8')
  })
})
