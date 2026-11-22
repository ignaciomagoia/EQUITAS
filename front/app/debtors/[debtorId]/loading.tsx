import { LoaderCircle } from 'lucide-react'

import { AppShell } from '@/components/layout/app-shell'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

export default function DebtorDetailLoading() {
  return (
    <AppShell>
      <section className="space-y-6" aria-busy="true" aria-live="polite">
        <div className="flex items-center gap-3 text-sm text-slate-600">
          <LoaderCircle className="size-5 animate-spin text-[#163a63]" />
          <span>Cargando detalle del objeto de deuda...</span>
        </div>

        <div className="space-y-3">
          <div className="h-7 w-48 animate-pulse rounded bg-slate-200" />
          <div className="h-4 w-80 max-w-full animate-pulse rounded bg-slate-200" />
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-6">
          {Array.from({ length: 6 }, (_, index) => (
            <Card key={index} className="border-slate-200">
              <CardHeader className="pb-2">
                <div className="h-3 w-20 animate-pulse rounded bg-slate-200" />
              </CardHeader>
              <CardContent>
                <div className="h-6 w-24 animate-pulse rounded bg-slate-200" />
              </CardContent>
            </Card>
          ))}
        </div>

        <Card className="border-slate-200">
          <CardContent className="space-y-4 py-6">
            <div className="h-5 w-44 animate-pulse rounded bg-slate-200" />
            <div className="h-40 animate-pulse rounded bg-slate-100" />
          </CardContent>
        </Card>
      </section>
    </AppShell>
  )
}
