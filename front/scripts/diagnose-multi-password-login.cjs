#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Diagnostico interactivo de Auth Multiinstitución.
 * No persiste sesiones, no imprime contraseñas, claves ni tokens y no modifica
 * datos operativos. Un inicio de sesión exitoso actualiza last_sign_in_at,
 * comportamiento normal de Supabase Auth.
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
    'Uso: node scripts/diagnose-multi-password-login.cjs --user-id <uuid> --email <email>'
  )
}

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`No se encontro ${filePath}.`)

  const values = {}
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/)
    if (!match) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    values[match[1].trim()] = value
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

  if (
    parsedUrl.protocol !== 'https:' ||
    parsedUrl.hostname !== `${EXPECTED_PROJECT_REF}.supabase.co`
  ) {
    throw new Error('El diagnostico solo puede ejecutarse contra EQUITAS-TP-TESTING.')
  }
}

function promptHidden(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    return Promise.reject(new Error('Se requiere una terminal interactiva para ocultar la contraseña.'))
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
      } else if (character === '\r' || character === '\n') {
        cleanup()
        resolve(value)
      } else if (character === '\u0008' || character === '\u007f') {
        value = value.slice(0, -1)
      } else {
        value += character
      }
    }
    stdin.on('data', onData)
  })
}

async function requireRecord(query, message) {
  const { data, error } = await query
  if (error || !data) throw new Error(message)
  return data
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage()
    return
  }

  const userId = readArgument('--user-id')
  const email = readArgument('--email')?.toLowerCase()
  if (!userId || !email) {
    printUsage()
    throw new Error('Se requieren --user-id y --email.')
  }

  const env = readEnvFile(path.resolve(process.cwd(), '.env.local'))
  const url = env.NEXT_PUBLIC_MULTI_SUPABASE_URL
  const publishableKey = env.NEXT_PUBLIC_MULTI_SUPABASE_PUBLISHABLE_KEY
  const serviceRoleKey = env.MULTI_SUPABASE_SERVICE_ROLE_KEY
  if (!url || !publishableKey || !serviceRoleKey) {
    throw new Error('Faltan variables Multiinstitución requeridas en .env.local.')
  }
  validateProjectUrl(url)

  // Comprueba que la clave privada puede consultar el mismo proyecto esperado.
  const adminClient = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const authUser = await adminClient.auth.admin.getUserById(userId)
  if (authUser.error || !authUser.data.user || authUser.data.user.email?.toLowerCase() !== email) {
    throw new Error('La service role Multi no corresponde al usuario esperado de EQUITAS-TP-TESTING.')
  }
  const appUser = await requireRecord(
    adminClient.from('app_user').select('id,email,status').eq('id', userId).eq('status', 'ACTIVE').maybeSingle(),
    'No existe app_user activo para el UUID indicado en Multiinstitución.'
  )
  if (appUser.email?.toLowerCase() !== email) {
    throw new Error('El email de app_user no coincide con Auth.')
  }

  const password = await promptHidden('Contraseña a verificar: ')
  if (!password) throw new Error('La contraseña no puede estar vacia.')

  // Cliente equivalente al que usa el navegador: URL + publishable key Multi.
  const browserEquivalentClient = createClient(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  })
  const login = await browserEquivalentClient.auth.signInWithPassword({ email, password })
  if (login.error || !login.data.user) {
    const code = login.error?.code ?? 'SIN_CODIGO'
    const message = login.error?.message ?? 'Sin mensaje de Supabase.'
    throw new Error(`Auth Multi rechazo el inicio de sesion. code=${code}; message=${message}`)
  }
  if (login.data.user.id !== userId || login.data.user.email?.toLowerCase() !== email) {
    throw new Error('Auth devolvio una identidad distinta de la validada. No continue con el frontend.')
  }

  // RLS confirma que el access token emitido por la publishable key pertenece a la misma base.
  const rlsCheck = await browserEquivalentClient
    .from('app_user')
    .select('id,email,status')
    .eq('id', userId)
    .maybeSingle()
  if (rlsCheck.error || !rlsCheck.data || rlsCheck.data.email?.toLowerCase() !== email) {
    throw new Error('La sesion Auth emitida no puede leer app_user mediante RLS Multi.')
  }

  const membership = await requireRecord(
    browserEquivalentClient
      .from('institution_membership')
      .select('institution_id,status')
      .eq('user_id', userId)
      .eq('status', 'ACTIVE')
      .maybeSingle(),
    'La sesion no puede leer una membresia institucional activa.'
  )
  const institution = await requireRecord(
    browserEquivalentClient
      .from('institution')
      .select('slug,status')
      .eq('id', membership.institution_id)
      .maybeSingle(),
    'La sesion no puede leer su institucion activa.'
  )
  if (institution.slug !== EXPECTED_INSTITUTION_SLUG || institution.status !== 'ACTIVE') {
    throw new Error('La sesion no corresponde a Universidad Demo activa.')
  }

  await browserEquivalentClient.auth.signOut()
  console.log('Diagnostico correcto: Auth publico, Auth administrativo y RLS corresponden a Multiinstitución.')
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : 'Fallo inesperado.')
})
