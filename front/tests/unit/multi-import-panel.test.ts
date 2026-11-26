import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase-browser', () => ({
  createBrowserSupabaseClient: vi.fn(() => null),
}))

import { MultiImportPanel } from '@/components/imports/multi-import-panel'

describe('panel de importaciÃ³n MultiinstituciÃ³n', () => {
  it('presenta una simulaciÃ³n segura como flujo inicial', () => {
    const html = renderToStaticMarkup(createElement(MultiImportPanel))

    expect(html).toContain('Importar archivo de deudas')
    expect(html).toContain('Ejecutar simulaci')
    expect(html).toContain('Volver a simular aunque el archivo ya')
    expect(html).toContain('Cargando historial')
    expect(html).toContain('Seleccion')
  })

  it('explica que una actualizaciÃ³n real depende de una simulaciÃ³n validada', () => {
    const html = renderToStaticMarkup(createElement(MultiImportPanel))

    expect(html).toContain('Las actualizaciones reales requieren una simulaci')
  })
})
