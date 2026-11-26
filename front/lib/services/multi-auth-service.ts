import { createBrowserSupabaseClient } from '@/lib/supabase-browser'

export type MultiInstitutionAccessContext = {
  authUserId: string
  appUserId: string
  institutionId: string
  institutionName: string
  institutionSlug: string
  // Alias de compatibilidad para los componentes que antes consumian tenantId.
  tenantId: string
  role: string
}

export type MultiInstitutionAccessValidation = {
  isAuthorized: boolean
  requiresLogin: boolean
  code?: 'AUTH_REQUIRED' | 'APP_USER_NOT_FOUND' | 'INSTITUTION_ACCESS_NOT_FOUND' | 'DATABASE_ERROR' | 'SUPABASE_NOT_CONFIGURED'
  message?: string
  context?: MultiInstitutionAccessContext
}

function unauthorized(
  code: NonNullable<MultiInstitutionAccessValidation['code']>,
  message: string,
  requiresLogin = false
): MultiInstitutionAccessValidation {
  return { isAuthorized: false, requiresLogin, code, message }
}

export async function validateMultiInstitutionAccess(
  authUserId: string,
  supabase = createBrowserSupabaseClient('multi')
): Promise<MultiInstitutionAccessValidation> {
  if (!supabase) {
    return unauthorized('SUPABASE_NOT_CONFIGURED', 'La plataforma multiinstitucion no esta configurada.')
  }

  const [userResponse, institutionResponse] = await Promise.all([
    supabase.from('app_user').select('id,status').eq('id', authUserId).maybeSingle(),
    supabase.rpc('ensure_active_institution'),
  ])

  if (userResponse.error || institutionResponse.error) {
    return unauthorized(
      'DATABASE_ERROR',
      'No se pudo validar el acceso institucional. Intente nuevamente o contacte al administrador.'
    )
  }

  if (!userResponse.data || userResponse.data.status !== 'ACTIVE') {
    return unauthorized('APP_USER_NOT_FOUND', 'El usuario no esta habilitado en la plataforma.')
  }

  const institutionId = institutionResponse.data
  if (!Number.isSafeInteger(institutionId) || institutionId <= 0) {
    return unauthorized(
      'INSTITUTION_ACCESS_NOT_FOUND',
      'No hay una institucion activa asignada. Contacte al administrador de EQUITAS.'
    )
  }

  const membershipResponse = await supabase
    .from('institution_membership')
    .select('id,institution_id,status,institution(name,slug)')
    .eq('user_id', authUserId)
    .eq('institution_id', institutionId)
    .eq('status', 'ACTIVE')
    .maybeSingle()

  if (membershipResponse.error) {
    return unauthorized('DATABASE_ERROR', 'No se pudo validar la membresia institucional.')
  }

  if (!membershipResponse.data) {
    return unauthorized('INSTITUTION_ACCESS_NOT_FOUND', 'No existe una membresia institucional activa.')
  }

  const institution = Array.isArray(membershipResponse.data.institution)
    ? membershipResponse.data.institution[0]
    : membershipResponse.data.institution
  if (!institution || typeof institution.name !== 'string' || typeof institution.slug !== 'string') {
    return unauthorized('INSTITUTION_ACCESS_NOT_FOUND', 'No se pudo resolver la institución asignada.')
  }

  const rolesResponse = await supabase
    .from('institution_membership_role')
    .select('institution_role(code)')
    .eq('membership_id', membershipResponse.data.id)
    .eq('institution_id', institutionId)

  if (rolesResponse.error) {
    return unauthorized('DATABASE_ERROR', 'No se pudo validar el rol institucional.')
  }

  const roleAssignments = (rolesResponse.data ?? []) as unknown as Array<{
    institution_role?: { code?: unknown } | Array<{ code?: unknown }>
  }>
  const role =
    roleAssignments
      .map((assignment) => {
        const linkedRole = assignment.institution_role
        return Array.isArray(linkedRole) ? linkedRole[0]?.code : linkedRole?.code
      })
      .find((value): value is string => typeof value === 'string' && value.length > 0) ?? 'member'

  return {
    isAuthorized: true,
    requiresLogin: false,
    context: {
      authUserId,
      appUserId: userResponse.data.id,
      institutionId: String(institutionId),
      institutionName: institution.name,
      institutionSlug: institution.slug,
      tenantId: String(institutionId),
      role,
    },
  }
}

export async function validateCurrentMultiInstitutionAccess(): Promise<MultiInstitutionAccessValidation> {
  const supabase = createBrowserSupabaseClient('multi')
  if (!supabase) {
    return unauthorized('SUPABASE_NOT_CONFIGURED', 'La plataforma multiinstitucion no esta configurada.')
  }

  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) {
    return unauthorized('AUTH_REQUIRED', 'Debe iniciar sesion para continuar.', true)
  }

  return validateMultiInstitutionAccess(data.user.id, supabase)
}
