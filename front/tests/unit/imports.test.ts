import { describe, expect, it } from 'vitest'

import {
  buildImportCreatePayload,
  calculateImportProgress,
  canUseImportMode,
  importModeLabel,
  isImportMode,
  shouldUpdateSelectedImportDetail,
} from '@/lib/imports'

describe('import CSV helpers', () => {
  it('accepts only supported import modes', () => {
    // Arrange / Act / Assert
    expect(isImportMode('dry_run')).toBe(true)
    expect(isImportMode('apply')).toBe(true)
    expect(isImportMode('preview')).toBe(false)
  })

  it('builds an apply payload without dry-run retry flags', () => {
    // Arrange / Act
    const payload = buildImportCreatePayload('actualizacion.csv', 512, 'a'.repeat(64), 'apply', true)

    // Assert
    expect(payload).toMatchObject({
      action: 'create',
      mode: 'apply',
      forceNewDryRun: false,
    })
    expect(importModeLabel(payload.mode)).toBe('Actualización real')
  })

  it('reports staged progress without declaring completion early', () => {
    // Arrange
    const job = { status: 'STAGING', total_rows: 100, processed_rows: 50 }

    // Act
    const progress = calculateImportProgress(job)

    // Assert
    expect(progress).toBe(45)
  })

  it('reports one hundred percent only for terminal completed statuses', () => {
    // Arrange / Act / Assert
    expect(calculateImportProgress({ status: 'DRY_RUN_COMPLETED', total_rows: 0, processed_rows: 0 })).toBe(100)
    expect(calculateImportProgress({ status: 'COMPLETED_WITH_ERRORS', total_rows: 20, processed_rows: 20 })).toBe(100)
    expect(calculateImportProgress({ status: 'FAILED', total_rows: 20, processed_rows: 20 })).toBe(90)
  })

  it('keeps the selected import detail when a stale request finishes later', () => {
    // Arrange
    const selectedJobId = 24

    // Act / Assert
    expect(shouldUpdateSelectedImportDetail(selectedJobId, 13, true)).toBe(false)
    expect(shouldUpdateSelectedImportDetail(selectedJobId, 24, false)).toBe(false)
    expect(shouldUpdateSelectedImportDetail(selectedJobId, 24, true)).toBe(true)
  })

  it('requires an explicit active authorization even for dry runs', () => {
    // Arrange
    const authorized = { active: true, canImport: true, canApply: false }

    // Act / Assert
    expect(canUseImportMode(null, 'dry_run')).toBe(false)
    expect(canUseImportMode({ ...authorized, active: false }, 'dry_run')).toBe(false)
    expect(canUseImportMode({ ...authorized, canImport: false }, 'dry_run')).toBe(false)
    expect(canUseImportMode(authorized, 'dry_run')).toBe(true)
  })

  it('requires both the database feature flag and the user permission for apply', () => {
    // Arrange
    const canImportOnly = { active: true, canImport: true, canApply: false }
    const canApply = { active: true, canImport: true, canApply: true }

    // Act / Assert
    expect(canUseImportMode(canImportOnly, 'apply', true)).toBe(false)
    expect(canUseImportMode(canApply, 'apply', false)).toBe(false)
    expect(canUseImportMode(canApply, 'apply', true)).toBe(true)
  })
})
