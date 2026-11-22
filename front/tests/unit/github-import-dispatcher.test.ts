import { describe, expect, it, vi } from 'vitest'

import {
  dispatchLafaldaCsvImport,
  shouldDispatchImportWorkflow,
} from '@/lib/github-import-dispatcher'

const configuredEnvironment = {
  GITHUB_IMPORT_DISPATCH_TOKEN: 'test-dispatch-token',
  GITHUB_IMPORT_REPOSITORY: 'equitas-org/equitas',
  GITHUB_IMPORT_WORKFLOW_FILE: 'lafalda-csv-import.yml',
  GITHUB_IMPORT_WORKFLOW_REF: 'main',
}

describe('GitHub import workflow dispatcher', () => {
  it('dispatches the worker workflow for a queued import', async () => {
    // Arrange
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))

    // Act
    const result = await dispatchLafaldaCsvImport(42, {
      environment: configuredEnvironment,
      fetchImplementation,
    })

    // Assert
    expect(result).toEqual({ status: 'dispatched' })
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://api.github.com/repos/equitas-org/equitas/actions/workflows/lafalda-csv-import.yml/dispatches',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ref: 'main', inputs: { job_id: '42' } }),
      }),
    )
  })

  it('reports a GitHub error without throwing or exposing its response', async () => {
    // Arrange
    const fetchImplementation = vi.fn().mockResolvedValue(new Response('internal detail', { status: 503 }))

    // Act
    const result = await dispatchLafaldaCsvImport(42, {
      environment: configuredEnvironment,
      fetchImplementation,
    })

    // Assert
    expect(result).toEqual({ status: 'failed' })
  })

  it('does not contact GitHub when the server token is absent', async () => {
    // Arrange
    const fetchImplementation = vi.fn()

    // Act
    const result = await dispatchLafaldaCsvImport(42, {
      environment: { GITHUB_IMPORT_REPOSITORY: 'equitas-org/equitas' },
      fetchImplementation,
    })

    // Assert
    expect(result).toEqual({ status: 'not_configured' })
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it('prevents a duplicate dispatch once a job is already queued', () => {
    // Arrange / Act / Assert
    expect(shouldDispatchImportWorkflow('UPLOADING', 'QUEUED')).toBe(true)
    expect(shouldDispatchImportWorkflow('FAILED', 'QUEUED')).toBe(true)
    expect(shouldDispatchImportWorkflow('QUEUED', 'QUEUED')).toBe(false)
    expect(shouldDispatchImportWorkflow('STAGING', 'QUEUED')).toBe(false)
  })
})
