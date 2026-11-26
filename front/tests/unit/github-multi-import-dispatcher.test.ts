import { describe, expect, it, vi } from 'vitest'

import { dispatchMultiInstitutionCsvImport } from '@/lib/github-multi-import-dispatcher'

describe('disparo del worker Multiinstitución', () => {
  it('usa variables separadas de La Falda y no incluye secretos en la URL', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))

    const result = await dispatchMultiInstitutionCsvImport(81, {
      environment: {
        GITHUB_MULTI_IMPORT_DISPATCH_TOKEN: 'token-privado',
        GITHUB_MULTI_IMPORT_REPOSITORY: 'equitas-org/equitas',
      },
      fetchImplementation,
    })

    expect(result).toEqual({ status: 'dispatched' })
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://api.github.com/repos/equitas-org/equitas/actions/workflows/multiinstitution-csv-import.yml/dispatches',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(JSON.parse(fetchImplementation.mock.calls[0][1].body)).toEqual({ ref: 'main', inputs: { job_id: '81' } })
  })

  it('no intenta un disparo si falta el token específico de Multiinstitución', async () => {
    const fetchImplementation = vi.fn()
    await expect(dispatchMultiInstitutionCsvImport(81, { environment: {}, fetchImplementation })).resolves.toEqual({ status: 'not_configured' })
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it('mantiene el trabajo recuperable cuando GitHub rechaza el despacho', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(null, { status: 503 }))

    await expect(dispatchMultiInstitutionCsvImport(81, {
      environment: {
        GITHUB_MULTI_IMPORT_DISPATCH_TOKEN: 'token-privado',
        GITHUB_MULTI_IMPORT_REPOSITORY: 'equitas-org/equitas',
      },
      fetchImplementation,
    })).resolves.toEqual({ status: 'failed' })
  })
})
