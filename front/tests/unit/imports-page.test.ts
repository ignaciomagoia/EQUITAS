import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ source: 'legacy' as 'legacy' | 'multi' }))

vi.mock('@/components/layout/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => createElement('main', { 'data-shell': 'equitas' }, children),
}))
vi.mock('@/components/imports/import-panel', () => ({
  ImportPanel: ({ applyEnabled }: { applyEnabled: boolean }) => createElement('div', null, `legacy:${applyEnabled}`),
}))
vi.mock('@/components/imports/multi-import-panel', () => ({
  MultiImportPanel: () => createElement('div', null, 'multi-panel'),
}))
vi.mock('@/lib/auth/auth-source-server', () => ({ getCurrentSupabaseSource: vi.fn(async () => state.source) }))
vi.mock('@/lib/imports', () => ({ isLafaldaApplyEnabled: vi.fn(() => true) }))

import ImportsPage from '@/app/imports/page'

beforeEach(() => { state.source = 'legacy' })

describe('pagina de importacion', () => {
  it('muestra el flujo de La Falda con APPLY condicionado por el entorno', async () => {
    const html = renderToStaticMarkup(await ImportsPage())

    expect(html).toContain('Importar CSV')
    expect(html).toContain('Actualizacion diaria de obligaciones')
    expect(html).toContain('legacy:true')
  })

  it('muestra el panel multiinstitucion segun la fuente autenticada', async () => {
    state.source = 'multi'
    const html = renderToStaticMarkup(await ImportsPage())

    expect(html).toContain('Simul')
    expect(html).toContain('multi-panel')
    expect(html).not.toContain('legacy:true')
  })
})
