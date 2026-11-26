export const MULTI_IMPORT_BUCKET = 'equitas-multi-imports'
export const MULTI_IMPORT_MAX_FILE_SIZE = 100 * 1024 * 1024

export type MultiImportMode = 'DRY_RUN' | 'APPLY'
export type MultiImportMapping = Record<string, string>

export type MultiImportJob = {
  id: number
  file_name: string
  file_size_bytes: number
  mode: MultiImportMode
  status: string
  simulation_job_id?: number | null
  total_rows: number
  processed_rows: number
  inserted_rows: number
  updated_rows: number
  unchanged_rows: number
  rejected_rows: number
  ignored_columns: string[]
  dry_run_summary: Record<string, unknown>
  error_message: string | null
  created_at: string
  completed_at: string | null
  merge_completed_at?: string | null
  profiles_recalculated_at?: string | null
  profile_recalculation_error?: string | null
}

export type MultiImportStructure = {
  encoding: 'UTF-8' | 'UTF-8-SIG' | 'WINDOWS-1252'
  delimiter: ',' | ';' | '\t'
  headers: string[]
  mapping: MultiImportMapping
  ignoredColumns: string[]
  missingRequiredFields: string[]
  ambiguousFields: Record<string, string[]>
}

export const MULTI_IMPORT_FIELDS = [
  { key: 'debtor_external_reference', label: 'Identificador del objeto', required: true, aliases: ['cuenta', 'cuenta_id', 'numero_cuenta', 'nro_cuenta', 'codigo_cuenta', 'legajo', 'objeto_id', 'id_objeto', 'debtor_id', 'external_debtor_id', 'cuenta_universitaria', 'referencia_objeto'] },
  { key: 'debt_external_reference', label: 'Identificador de la deuda', required: true, aliases: ['deud_id', 'deuda_id', 'id_deuda', 'numero_deuda', 'nro_deuda', 'external_debt_id', 'comprobante_de_deuda'] },
  { key: 'original_amount', label: 'Importe original', required: false, aliases: ['notd_capital', 'capital', 'importe_original', 'monto_original', 'saldo_original'] },
  { key: 'current_amount', label: 'Importe actual', required: false, aliases: ['notd_totalactualizado', 'total_actualizado', 'importe_actual', 'importe_actualizado', 'monto_actualizado', 'saldo', 'saldo_actualizado', 'importe', 'monto', 'current_amount'] },
  { key: 'debtor_identifier', label: 'Código del objeto', required: false, aliases: ['identificador', 'identificador_objeto', 'codigo_objeto'] },
  { key: 'debtor_description', label: 'Descripción del objeto', required: false, aliases: ['bien_descripcion', 'descripcion_objeto', 'detalle_objeto', 'nombre_objeto'] },
  { key: 'object_type', label: 'Tipo de objeto', required: false, aliases: ['bien_tipo_id', 'tipo_bien', 'tipo_objeto', 'object_type', 'categoria_objeto'] },
  { key: 'person_external_reference', label: 'Identificador de persona', required: false, aliases: ['destinatario_id', 'persona_id', 'cliente_id', 'deudor_id', 'external_person_id'] },
  { key: 'person_full_name', label: 'Nombre o razón social', required: false, aliases: ['destinatario', 'nombre', 'nombre_apellido', 'nombre_completo', 'razon_social', 'titular', 'persona'] },
  { key: 'person_document_number', label: 'Documento', required: false, aliases: ['dni', 'cuit', 'cuil', 'documento', 'destinatario_cuit', 'numero_documento'] },
  { key: 'person_email', label: 'Email', required: false, aliases: ['email', 'correo', 'correo_electronico', 'correo_institucional', 'destinatario_email', 'mail'] },
  { key: 'person_phone', label: 'Teléfono', required: false, aliases: ['telefono', 'celular', 'movil', 'destinatario_telefono', 'destinatario_celular'] },
  { key: 'debt_type', label: 'Tipo de deuda', required: false, aliases: ['tipo_deuda', 'tipo_ingreso', 'concepto_tipo', 'debt_type'] },
  { key: 'debt_description', label: 'Concepto o descripción', required: false, aliases: ['descripcion', 'detalle', 'concepto', 'descripcion_deuda', 'debt_description'] },
  { key: 'issue_date', label: 'Fecha de emisión', required: false, aliases: ['fecha_emision', 'emision', 'issue_date'] },
  { key: 'due_date', label: 'Fecha de vencimiento', required: false, aliases: ['notd_vencimiento', 'vencimiento', 'fecha_vencimiento', 'fecha_de_vencimiento', 'due_date'] },
  { key: 'status', label: 'Estado', required: false, aliases: ['estado', 'estado_deuda', 'debt_status'] },
  { key: 'period', label: 'Período', required: false, aliases: ['periodo', 'periodo_deuda', 'period'] },
] as const

const REQUIRED_MAPPING_FIELDS = ['debtor_external_reference', 'debt_external_reference']

export function normalizeMultiImportHeader(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

function parseCsvLine(line: string, delimiter: string) {
  const values: string[] = []
  let current = ''
  let quoted = false

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (character === delimiter && !quoted) {
      values.push(current.trim())
      current = ''
    } else {
      current += character
    }
  }
  values.push(current.trim())
  return values
}

function detectDelimiter(text: string): ',' | ';' | '\t' {
  const header = text.split(/\r?\n/).find((line) => line.trim()) ?? ''
  const counts = ([',', ';', '\t'] as const).map((delimiter) => ({
    delimiter,
    count: parseCsvLine(header, delimiter).length,
  }))
  const detected = counts.sort((left, right) => right.count - left.count)[0]
  if (!detected || detected.count < 2) {
    throw new Error('No se pudo identificar el separador del archivo CSV.')
  }
  return detected.delimiter
}

async function decodeCsv(file: File) {
  const bytes = new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer())
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const text = decoder.decode(bytes)
    return { text, encoding: text.charCodeAt(0) === 0xfeff ? 'UTF-8-SIG' as const : 'UTF-8' as const }
  } catch {
    return { text: new TextDecoder('windows-1252', { fatal: true }).decode(bytes), encoding: 'WINDOWS-1252' as const }
  }
}

export async function analyzeMultiImportFile(file: File): Promise<MultiImportStructure> {
  const { text, encoding } = await decodeCsv(file)
  const delimiter = detectDelimiter(text)
  const firstLine = text.split(/\r?\n/).find((line) => line.trim())
  if (!firstLine) throw new Error('El archivo CSV está vacío.')
  const headers = parseCsvLine(firstLine, delimiter).map((header) => header.replace(/^\ufeff/, '').trim())
  if (headers.some((header) => !header)) throw new Error('El archivo contiene encabezados vacíos.')

  const byNormalizedHeader = new Map<string, string[]>()
  headers.forEach((header) => {
    const key = normalizeMultiImportHeader(header)
    byNormalizedHeader.set(key, [...(byNormalizedHeader.get(key) ?? []), header])
  })
  if ([...byNormalizedHeader.values()].some((group) => group.length > 1)) {
    throw new Error('El archivo contiene encabezados repetidos o indistinguibles.')
  }

  const mapping: MultiImportMapping = {}
  const ambiguousFields: Record<string, string[]> = {}
  for (const field of MULTI_IMPORT_FIELDS) {
    const aliases = new Set([field.key, ...field.aliases].map(normalizeMultiImportHeader))
    const matches = headers.filter((header) => aliases.has(normalizeMultiImportHeader(header)))
    if (matches.length === 1) mapping[field.key] = matches[0]
    if (matches.length > 1) ambiguousFields[field.key] = matches
  }

  const usedHeaders = new Set(Object.values(mapping))
  return {
    encoding,
    delimiter,
    headers,
    mapping,
    ignoredColumns: headers.filter((header) => !usedHeaders.has(header)),
    missingRequiredFields: REQUIRED_MAPPING_FIELDS.filter((field) => !mapping[field]),
    ambiguousFields,
  }
}

export function multiImportProgress(job: Pick<MultiImportJob, 'status' | 'total_rows' | 'processed_rows'>) {
  if (job.status === 'DRY_RUN_COMPLETED' || job.status === 'COMPLETED') return 100
  if (job.total_rows <= 0) return 0
  return Math.min(95, Math.round((job.processed_rows / job.total_rows) * 100))
}
