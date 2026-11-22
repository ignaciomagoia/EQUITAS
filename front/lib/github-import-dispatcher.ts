const GITHUB_API_BASE_URL = 'https://api.github.com'
const DEFAULT_WORKFLOW_FILE = 'lafalda-csv-import.yml'
const DEFAULT_WORKFLOW_REF = 'main'

export type GitHubImportDispatchStatus = 'dispatched' | 'failed' | 'not_configured' | 'skipped'

export type GitHubImportDispatchResult = {
  status: GitHubImportDispatchStatus
}

type GitHubImportDispatchConfig = {
  token: string
  repository: string
  workflowFile: string
  ref: string
}

type FetchImplementation = typeof fetch
type Environment = Record<string, string | undefined>

function readRequiredEnvironmentValue(environment: Environment, name: string) {
  const value = environment[name]?.trim()
  return value || null
}

function getGitHubImportDispatchConfig(
  environment: Environment = process.env,
): GitHubImportDispatchConfig | null {
  const token = readRequiredEnvironmentValue(environment, 'GITHUB_IMPORT_DISPATCH_TOKEN')
  const repository = readRequiredEnvironmentValue(environment, 'GITHUB_IMPORT_REPOSITORY')

  if (!token || !repository || !repository.includes('/')) {
    return null
  }

  return {
    token,
    repository,
    workflowFile:
      readRequiredEnvironmentValue(environment, 'GITHUB_IMPORT_WORKFLOW_FILE') ?? DEFAULT_WORKFLOW_FILE,
    ref: readRequiredEnvironmentValue(environment, 'GITHUB_IMPORT_WORKFLOW_REF') ?? DEFAULT_WORKFLOW_REF,
  }
}

export function shouldDispatchImportWorkflow(previousStatus: string, nextStatus: string) {
  return nextStatus === 'QUEUED' && (previousStatus === 'UPLOADING' || previousStatus === 'FAILED')
}

export async function dispatchLafaldaCsvImport(
  jobId: number,
  options: {
    environment?: Environment
    fetchImplementation?: FetchImplementation
  } = {},
): Promise<GitHubImportDispatchResult> {
  if (!Number.isSafeInteger(jobId) || jobId <= 0) {
    return { status: 'skipped' }
  }

  const config = getGitHubImportDispatchConfig(options.environment)
  if (!config) {
    return { status: 'not_configured' }
  }

  const [owner, repository] = config.repository.split('/', 2)
  if (!owner || !repository) {
    return { status: 'not_configured' }
  }

  const fetchImplementation = options.fetchImplementation ?? fetch
  const workflowPath = encodeURIComponent(config.workflowFile)
  const dispatchUrl = `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/workflows/${workflowPath}/dispatches`

  try {
    const response = await fetchImplementation(dispatchUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        ref: config.ref,
        inputs: { job_id: String(jobId) },
      }),
      cache: 'no-store',
    })

    return { status: response.ok ? 'dispatched' : 'failed' }
  } catch {
    return { status: 'failed' }
  }
}
