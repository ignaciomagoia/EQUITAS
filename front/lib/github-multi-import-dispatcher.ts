const GITHUB_API_BASE_URL = 'https://api.github.com'
const DEFAULT_WORKFLOW_FILE = 'multiinstitution-csv-import.yml'
const DEFAULT_WORKFLOW_REF = 'main'

type Environment = Record<string, string | undefined>

export type MultiImportDispatchStatus = 'dispatched' | 'failed' | 'not_configured' | 'skipped'

export type MultiImportDispatchResult = {
  status: MultiImportDispatchStatus
}

function configuredValue(environment: Environment, name: string) {
  return environment[name]?.trim() || null
}

export async function dispatchMultiInstitutionCsvImport(
  jobId: number,
  options: { environment?: Environment; fetchImplementation?: typeof fetch } = {},
): Promise<MultiImportDispatchResult> {
  if (!Number.isSafeInteger(jobId) || jobId <= 0) return { status: 'skipped' }
  const environment = options.environment ?? process.env
  const token = configuredValue(environment, 'GITHUB_MULTI_IMPORT_DISPATCH_TOKEN')
  const repository = configuredValue(environment, 'GITHUB_MULTI_IMPORT_REPOSITORY')
  if (!token || !repository || !repository.includes('/')) return { status: 'not_configured' }

  const [owner, name] = repository.split('/', 2)
  if (!owner || !name) return { status: 'not_configured' }
  const workflow = configuredValue(environment, 'GITHUB_MULTI_IMPORT_WORKFLOW_FILE') ?? DEFAULT_WORKFLOW_FILE
  const ref = configuredValue(environment, 'GITHUB_MULTI_IMPORT_WORKFLOW_REF') ?? DEFAULT_WORKFLOW_REF
  try {
    const response = await (options.fetchImplementation ?? fetch)(
      `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ ref, inputs: { job_id: String(jobId) } }),
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      },
    )
    return { status: response.ok ? 'dispatched' : 'failed' }
  } catch {
    return { status: 'failed' }
  }
}
