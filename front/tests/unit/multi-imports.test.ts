import { describe, expect, it } from 'vitest'

import { analyzeMultiImportFile, multiImportProgress } from '@/lib/multi-imports'

function csvFile(content: string, name = 'institucion.csv') {
  return new File([content], name, { type: 'text/csv' })
}

describe('analisis de CSV multiinstitucion', () => {
  it('detecta aliases, punto y coma y columnas desconocidas sin depender de Supabase', async () => {
    const structure = await analyzeMultiImportFile(
      csvFile('Cuenta;Deuda Id;Saldo;Columna extra\nUNI-1;AR-1;1200,00;ignorar\n'),
    )

    expect(structure.delimiter).toBe(';')
    expect(structure.mapping).toMatchObject({
      debtor_external_reference: 'Cuenta',
      debt_external_reference: 'Deuda Id',
      current_amount: 'Saldo',
    })
    expect(structure.ignoredColumns).toEqual(['Columna extra'])
  })

  it('rechaza encabezados que se normalizan al mismo valor', async () => {
    await expect(
      analyzeMultiImportFile(csvFile('Cuenta;CUÉNTA;Deuda Id\nUNI-1;UNI-1;AR-1\n')),
    ).rejects.toThrow('repetidos o indistinguibles')
  })

  it('calcula un avance seguro para trabajos activos y finalizados', () => {
    expect(multiImportProgress({ status: 'STAGING', processed_rows: 50, total_rows: 100 })).toBe(50)
    expect(multiImportProgress({ status: 'DRY_RUN_COMPLETED', processed_rows: 99, total_rows: 100 })).toBe(100)
  })
})
