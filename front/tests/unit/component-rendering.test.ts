import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  usePathname: () => '/debtors',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))

vi.mock('next/image', () => ({ default: (props: Record<string, unknown>) => createElement('img', props) }))
vi.mock('next/link', () => ({ default: ({ children, ...props }: { children: ReactNode }) => createElement('a', props, children) }))
vi.mock('@/components/auth/auth-provider', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuthState: () => ({ source: 'multi', tenant: { name: 'Universidad Demo' } }),
}))
vi.mock('@/components/auth/auth-guard', () => ({ AuthGuard: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/components/layout/logout-button', () => ({ LogoutButton: () => createElement('button', null, 'Cerrar sesion') }))
vi.mock('@/lib/supabase-browser', () => ({ createBrowserSupabaseClient: vi.fn(() => null) }))

import { AppShell } from '@/components/layout/app-shell'
import { DebtorsFiltersForm } from '@/components/debtors/debtors-filters-form'
import { PeopleFiltersForm } from '@/components/people/people-filters-form'
import { ImportPanel } from '@/components/imports/import-panel'
import { PersonContactDialog } from '@/components/people/person-contact-dialog'
import { BarDistributionChart, RiskDonutChart, TopDebtHorizontalChart } from '@/components/charts/debtor-dashboard-charts'
import { PaginationControls, PaginationSummary } from '@/components/equitas/pagination-controls'
import { DataWarnings } from '@/components/equitas/data-warnings'
import { RiskBadge } from '@/components/equitas/risk-badge'
import { PersonRiskBadge } from '@/components/people/person-risk-badge'
import { ContactAvailabilityBadge } from '@/components/debtors/contact-availability-badge'

describe('componentes operativos renderizados', () => {
  it('muestra la navegaciÃ³n institucional y conserva todas las rutas operativas', () => {
    const html = renderToStaticMarkup(createElement(AppShell, null, createElement('p', null, 'Contenido')))

    expect(html).toContain('Universidad Demo')
    expect(html).toContain('Importar CSV')
    expect(html).toContain('Acciones recomendadas')
    expect(html).toContain('Contenido')
  })

  it('presenta filtros de objetos con opciones recibidas desde el servidor', () => {
    const html = renderToStaticMarkup(createElement(DebtorsFiltersForm, {
      initialValues: { q: 'OBJ-1', risk: 'ALTO', status: 'ACTIVO', type: 'INMUEBLE', contact: 'with', personId: '7' },
      riskOptions: ['BAJO', 'MEDIO', 'ALTO'], statusOptions: ['ACTIVO'], typeOptions: ['INMUEBLE'],
    }))

    expect(html).toContain('Buscar por objeto o persona')
    expect(html).toContain('Alto (70-100)')
    expect(html).toContain('INMUEBLE')
    expect(html).toContain('Aplicar filtros')
  })

  it('presenta filtros de personas y opciones de riesgo individual', () => {
    const html = renderToStaticMarkup(createElement(PeopleFiltersForm, { initialValues: { q: 'Ana', risk: 'MEDIO' } }))

    expect(html).toContain('Buscar por nombre o documento')
    expect(html).toContain('Riesgo individual')
    expect(html).toContain('Medio (40-69)')
  })

  it('mantiene la confirmaciÃ³n de APPLY separada de la simulaciÃ³n en el panel legado', () => {
    const disabled = renderToStaticMarkup(createElement(ImportPanel, { applyEnabled: false }))
    const enabled = renderToStaticMarkup(createElement(ImportPanel, { applyEnabled: true }))

    expect(disabled).toContain('Simular actualizaci')
    expect(disabled).toContain('Ejecutar')
    expect(enabled).toContain('Actualizar deudas')
  })

  it('muestra un contacto institucional sin exponer Telegram para MultiinstituciÃ³n', () => {
    const html = renderToStaticMarkup(createElement(PersonContactDialog, {
      personId: 'person-1', personName: 'Ana Demo',
      contacts: [{ channel: 'Email', value: 'ana@example.test' }, { channel: 'Celular', value: '3511234567' }],
      totalDebtAssociated: 1500, debtorIdentifiers: ['ALU-2026-001'],
    }))

    expect(html).toContain('Disponible')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).not.toContain('Asistente de Telegram')
  })

  it('renderiza estados vacÃ­os de los tres grÃ¡ficos ejecutivos', () => {
    const html = renderToStaticMarkup(createElement('div', null,
      createElement(BarDistributionChart, { title: 'Objetos por tipo', data: [] }),
      createElement(RiskDonutChart, { title: 'Riesgo', data: [], legendLayout: 'bottom', size: 'compact' }),
      createElement(TopDebtHorizontalChart, { title: 'Top de deuda', data: [], size: 'compact' }),
    ))

    expect(html).toContain('Objetos por tipo')
    expect(html).toContain('Riesgo')
    expect(html).toContain('Top de deuda')
  })

  it('renderiza paginaciÃ³n, alertas y badges con los datos del dominio', () => {
    const href = (page: number, size: number) => `/debtors?page=${page}&size=${size}`
    const html = renderToStaticMarkup(createElement('div', null,
      createElement(PaginationSummary, { currentStart: 1, currentEnd: 10, totalItems: 25, itemLabel: 'objetos', pageSize: 10, buildHref: href }),
      createElement(PaginationControls, { currentPage: 2, totalPages: 3, pageSize: 10, currentStart: 11, currentEnd: 20, totalItems: 25, itemLabel: 'objetos', buildHref: href }),
      createElement(DataWarnings, { warnings: [{ table: 'debt', message: 'Acceso restringido', needsSelectPolicy: true }] }),
      createElement(RiskBadge, { risk: 'ALTO', score: 92 }),
      createElement(RiskBadge, { risk: 'MEDIO', score: 55 }),
      createElement(PersonRiskBadge, { risk: 'BAJO', score: 20 }),
      createElement(ContactAvailabilityBadge, { hasContact: true }),
      createElement(ContactAvailabilityBadge, { hasContact: false }),
    ))

    expect(html).toContain('Mostrando 1-10 de 25 objetos.')
    expect(html).toContain('Pagina 2 de 3.')
    expect(html).toContain('Acceso restringido')
    expect(html).toContain('Alto (92)')
    expect(html).toContain('Medio (55)')
    expect(html).toContain('Bajo (20)')
    expect(html).toContain('Disponible')
    expect(html).toContain('Faltante')
  })
})
