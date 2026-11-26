#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Restablece exclusivamente la contraseña de un usuario de EQUITAS
 * Multiinstitución. No imprime secretos ni modifica La Falda.
 *
 * Uso:
 *   node scripts/reset-multi-user-password.cjs --user-id <uuid> --email <email>
 */

const fs = require('node:fs')
const path = require('node:path')
const { createClient } = require('@supabase/supabase-js')

const EXPECTED_PROJECT_REF = 'iylwghgvtydpmwidojdo'
const EXPECTED_INSTITUTION_SLUG = 'universidad-demo'

function fail(message) {
  console.error(`Error: ${message}`)
  process.exitCode = 1
}

function readArgument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined
}

function printUsage() {
  console.log(
    'Uso: node scripts/reset-multi-user-password.cjs --user-id <uuid> --email <email>'
  )
}

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`No se encontro ${filePath}.`)
  }

  const values = {}
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/)
    if (!match) continue

    const key = match[1].trim()
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    values[key] = value
  }
  return values
}

function validateProjectUrl(url) {
  let parsedUrl
  try {
    parsedUrl = new URL(url)
  } catch {
    throw new Error('NEXT_PUBLIC_MULTI_SUPABASE_URL no contiene una URL valida.')
  }

  const expectedHost = `${EXPECTED_PROJECT_REF}.supabase.co`
  if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== expectedHost) {
    throw new Error('El destino no es el proyecto EQUITAS-TP-TESTING autorizado.')
  }
}

function promptHidden(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    return Promise.reject(
      new Error('Este script debe ejecutarse en una terminal interactiva para ocultar la contraseña.')
    )
  }

  return new Promise((resolve, reject) => {
    let value = ''
    const stdin = process.stdin

    process.stdout.write(label)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    const cleanup = () => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stdout.write('\n')
    }

    const onData = (chunk) => {
      const character = String(chunk)
      if (character === '\u0003') {
        cleanup()
        reject(new Error('Operacion cancelada.'))
        return
      }
      if (character === '\r' || character === '\n') {
        cleanup()
        resolve(value)
        return
      }
      if (character === '\u0008' || character === '\u007f') {
        value = value.slice(0, -1)
        return
      }
      value += character
    }

    stdin.on('data', onData)
  })
}

async function requireSingle(query, errorMessage) {
  const { data, error } = await query
  if (error || !data) {
    throw new Error(errorMessage)
  }
  return data
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage()
    return
  }

  const userId = readArgument('--user-id')
  const expectedEmail = readArgument('--email')?.toLowerCase()
  if (!userId || !expectedEmail) {
    printUsage()
    throw new Error('Se requieren --user-id y --email.')
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error('El UUID indicado no es valido.')
  }

  const env = readEnvFile(path.resolve(process.cwd(), '.env.local'))
  const url = env.NEXT_PUBLIC_MULTI_SUPABASE_URL
  const publishableKey = env.NEXT_PUBLIC_MULTI_SUPABASE_PUBLISHABLE_KEY
  const serviceRoleKey = env.MULTI_SUPABASE_SERVICE_ROLE_KEY
  if (!url || !publishableKey || !serviceRoleKey) {
    throw new Error('Faltan las variables Multiinstitución requeridas en .env.local.')
  }
  validateProjectUrl(url)

  const client = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const authResponse = await client.auth.admin.getUserById(userId)
  if (authResponse.error || !authResponse.data.user) {
    throw new Error('No se encontro el usuario Auth indicado en EQUITAS-TP-TESTING.')
  }
  if (authResponse.data.user.email?.toLowerCase() !== expectedEmail) {
    throw new Error('El UUID no corresponde al email indicado. No se realizo ningun cambio.')
  }

  const appUser = await requireSingle(
    client.from('app_user').select('id,email,status').eq('id', userId).eq('status', 'ACTIVE').maybeSingle(),
    'El usuario no tiene un registro app_user activo en Multiinstitución.'
  )
  if (appUser.email?.toLowerCase() !== expectedEmail) {
    throw new Error('El email de app_user no coincide. No se realizo ningun cambio.')
  }

  const platformRoleResponse = await client
    .from('platform_user_role')
    .select('user_id')
    .eq('user_id', userId)
  if (platformRoleResponse.error) {
    throw new Error('No se pudo verificar que el usuario no tenga roles globales.')
  }
  if ((platformRoleResponse.data ?? []).length > 0) {
    throw new Error('El usuario tiene un rol global de plataforma y no corresponde al piloto institucional.')
  }

  const membership = await requireSingle(
    client
      .from('institution_membership')
      .select('id,institution_id,status')
      .eq('user_id', userId)
      .eq('status', 'ACTIVE')
      .maybeSingle(),
    'El usuario no posee una membresia institucional activa unica.'
  )
  const institution = await requireSingle(
    client.from('institution').select('id,slug,status').eq('id', membership.institution_id).maybeSingle(),
    'No se encontro la institucion de la membresia.'
  )
  if (institution.slug !== EXPECTED_INSTITUTION_SLUG || institution.status !== 'ACTIVE') {
    throw new Error('La membresia no corresponde a Universidad Demo activa.')
  }

  const institutionAdminRole = await requireSingle(
    client.from('institution_role').select('id').eq('code', 'institution_admin').eq('active', true).maybeSingle(),
    'No existe un rol institution_admin activo.'
  )
  await requireSingle(
    client
      .from('institution_membership_role')
      .select('membership_id')
      .eq('membership_id', membership.id)
      .eq('institution_id', institution.id)
      .eq('role_id', institutionAdminRole.id)
      .maybeSingle(),
    'El usuario no posee el rol institution_admin de Universidad Demo.'
  )

  const password = await promptHidden('Nueva contraseña: ')
  const confirmation = await promptHidden('Repetir contraseña: ')
  if (!password || password !== confirmation) {
    throw new Error('Las contraseñas no coinciden o estan vacias.')
  }

  const updateResponse = await client.auth.admin.updateUserById(userId, { password })
  if (updateResponse.error || !updateResponse.data.user) {
    const code = updateResponse.error?.code ?? 'SIN_CODIGO'
    const message = updateResponse.error?.message ?? 'Sin mensaje de Supabase.'
    throw new Error(`Supabase no pudo actualizar la contraseña. code=${code}; message=${message}`)
  }
  if (
    updateResponse.data.user.id !== userId ||
    updateResponse.data.user.email?.toLowerCase() !== expectedEmail
  ) {
    throw new Error('La respuesta de Auth no coincide con el usuario validado.')
  }

  // Confirma en memoria que la contraseña ingresada se aplico al mismo usuario
  // contra el cliente publico Multi. No persiste token ni imprime credenciales.
  const verificationClient = createClient(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  })
  const verification = await verificationClient.auth.signInWithPassword({
    email: expectedEmail,
    password,
  })
  if (
    verification.error ||
    verification.data.user?.id !== userId ||
    verification.data.user.email?.toLowerCase() !== expectedEmail
  ) {
    const code = verification.error?.code ?? 'SIN_CODIGO'
    const message = verification.error?.message ?? 'Sin mensaje de Supabase.'
    throw new Error(
      `La contraseña se actualizo, pero la verificacion directa de Auth no fue satisfactoria. code=${code}; message=${message}`
    )
  }
  await verificationClient.auth.signOut()

  console.log('Contraseña actualizada correctamente para Universidad Demo.')
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : 'Fallo inesperado.')
})
