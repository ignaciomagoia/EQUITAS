import { beforeEach, describe, expect, it, vi } from 'vitest'

const { browserClient } = vi.hoisted(() => ({ browserClient: vi.fn() }))
vi.mock('@/lib/supabase-browser', () => ({ createBrowserSupabaseClient: browserClient }))

import { validateCurrentMultiInstitutionAccess, validateMultiInstitutionAccess } from '@/lib/services/multi-auth-service'

function createMultiClient({
  user = { id: 'user-1', status: 'ACTIVE' },
  institutionId = 10,
  membership = {
    id: 22,
    institution_id: 10,
    status: 'ACTIVE',
    institution: { name: 'Universidad Demo', slug: 'universidad-demo' },
  },
  roles = [{ institution_role: { code: 'institution_admin' } }],
  rolesError = null as unknown,
}: {
  user?: { id: string; status: string } | null
  institutionId?: number | null
  membership?: {
    id: number
    institution_id: number
    status: string
    institution: { name: string; slug: string }
  } | null
  roles?: unknown[]
  rolesError?: unknown
} = {}) {
  const queries: string[] = []
  const client = {
    rpc: vi.fn().mockResolvedValue({ data: institutionId, error: null }),
    from: vi.fn((table: string) => {
      queries.push(table)
      if (table === 'institution_membership_role') {
        const roleQuery = {
          select: vi.fn(() => roleQuery),
          eq: vi.fn(() => roleQuery),
          then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: roles, error: rolesError }).then(resolve),
        }
        return roleQuery
      }
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        maybeSingle: vi.fn(async () => {
          if (table === 'app_user') return { data: user, error: null }
          return { data: membership, error: null }
        }),
        then: undefined,
      }
      return query
    }),
  }
  return { client, queries }
}

describe('validacion de acceso multiinstitucion', () => {
  beforeEach(() => vi.resetAllMocks())

  it('autoriza solo una membresia activa con institucion seleccionada por RPC', async () => {
    const { client, queries } = createMultiClient()

    await expect(validateMultiInstitutionAccess('user-1', client as never)).resolves.toMatchObject({
      isAuthorized: true,
      context: {
        institutionId: '10',
        institutionName: 'Universidad Demo',
        institutionSlug: 'universidad-demo',
        tenantId: '10',
        role: 'institution_admin',
      },
    })
    expect(client.rpc).toHaveBeenCalledWith('ensure_active_institution')
    expect(queries).toEqual(['app_user', 'institution_membership', 'institution_membership_role'])
  })

  it('rechaza una sesion sin institucion activa', async () => {
    const { client } = createMultiClient({ institutionId: null })
    await expect(validateMultiInstitutionAccess('user-1', client as never)).resolves.toMatchObject({
      isAuthorized: false,
      code: 'INSTITUTION_ACCESS_NOT_FOUND',
    })
  })

  it('rechaza configuraciones incompletas antes de exponer datos institucionales', async () => {
    await expect(validateMultiInstitutionAccess('user-1', null as never)).resolves.toMatchObject({
      isAuthorized: false, code: 'SUPABASE_NOT_CONFIGURED',
    })

    const inactive = createMultiClient({ user: { id: 'user-1', status: 'INACTIVE' } })
    await expect(validateMultiInstitutionAccess('user-1', inactive.client as never)).resolves.toMatchObject({
      isAuthorized: false, code: 'APP_USER_NOT_FOUND',
    })

    const noMembership = createMultiClient({ membership: null })
    await expect(validateMultiInstitutionAccess('user-1', noMembership.client as never)).resolves.toMatchObject({
      isAuthorized: false, code: 'INSTITUTION_ACCESS_NOT_FOUND',
    })
  })

  it('rechaza una institucion mal formada o un error al consultar roles', async () => {
    const malformedInstitution = createMultiClient({
      membership: {
        id: 22, institution_id: 10, status: 'ACTIVE',
        institution: { name: 'Universidad Demo', slug: undefined as unknown as string },
      },
    })
    await expect(validateMultiInstitutionAccess('user-1', malformedInstitution.client as never)).resolves.toMatchObject({
      isAuthorized: false, code: 'INSTITUTION_ACCESS_NOT_FOUND',
    })

    const rolesFailure = createMultiClient({ rolesError: { message: 'RLS' } })
    await expect(validateMultiInstitutionAccess('user-1', rolesFailure.client as never)).resolves.toMatchObject({
      isAuthorized: false, code: 'DATABASE_ERROR',
    })
  })

  it('requiere una sesion autentica al validar el acceso actual', async () => {
    browserClient.mockReturnValue({ auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) } })

    await expect(validateCurrentMultiInstitutionAccess()).resolves.toMatchObject({
      isAuthorized: false, requiresLogin: true, code: 'AUTH_REQUIRED',
    })
  })
})
