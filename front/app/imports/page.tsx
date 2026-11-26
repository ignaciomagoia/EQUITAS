import { FileUp } from 'lucide-react'

import { ImportPanel } from '@/components/imports/import-panel'
import { MultiImportPanel } from '@/components/imports/multi-import-panel'
import { AppShell } from '@/components/layout/app-shell'
import { getCurrentSupabaseSource } from '@/lib/auth/auth-source-server'
import { isLafaldaApplyEnabled } from '@/lib/imports'

export const dynamic = 'force-dynamic'

export default async function ImportsPage() {
  const source = await getCurrentSupabaseSource()
  const isMultiInstitution = source === 'multi'

  return (
    <AppShell>
      <section className="mb-6 flex items-start gap-3">
        <div className="rounded-lg bg-[#edf3fa] p-2 text-[#163a63]">
          <FileUp className="size-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[#163a63]">Importar CSV</h1>
          <p className="mt-1 text-sm text-slate-600">
            {isMultiInstitution
              ? 'Simulá la carga de datos de tu institución antes de aplicar cambios.'
              : 'Actualizacion diaria de obligaciones para la Municipalidad de La Falda.'}
          </p>
        </div>
      </section>

      {isMultiInstitution ? <MultiImportPanel /> : <ImportPanel applyEnabled={isLafaldaApplyEnabled()} />}
    </AppShell>
  )
}
