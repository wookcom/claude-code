const MAX_FILES = 500

const repoOwner = process.env.GITHUB_REPO_OWNER ?? 'wookcom'
const repoName = process.env.GITHUB_REPO_NAME ?? 'claude-code'
const repoRef = process.env.GITHUB_REPO_REF ?? 'main'
const githubToken = process.env.GITHUB_TOKEN

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
  }
  if (githubToken) {
    headers.Authorization = `Bearer ${githubToken}`
  }
  return headers
}

export function sanitizePath(input: string): string | null {
  if (!input) return null
  const cleaned = input.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned || cleaned.includes('..')) return null
  return cleaned
}

export async function listWorkspaceFiles(): Promise<string[]> {
  const response = await fetch(
    `https://api.github.com/repos/${repoOwner}/${repoName}/git/trees/${repoRef}?recursive=1`,
    {
      headers: githubHeaders(),
      cache: 'no-store',
    },
  )

  if (!response.ok) {
    throw new Error('github_tree_fetch_failed')
  }

  const data = (await response.json()) as {
    tree?: Array<{ path: string; type: string }>
  }

  return (data.tree ?? [])
    .filter(entry => entry.type === 'blob')
    .map(entry => entry.path)
    .slice(0, MAX_FILES)
}

export async function readWorkspaceFile(relPath: string): Promise<string> {
  const safe = sanitizePath(relPath)
  if (!safe) throw new Error('invalid_path')
  const encodedPath = safe.split('/').map(encodeURIComponent).join('/')

  const response = await fetch(
    `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${encodedPath}?ref=${repoRef}`,
    {
      headers: githubHeaders(),
      cache: 'no-store',
    },
  )

  if (!response.ok) {
    throw new Error('github_file_fetch_failed')
  }

  const data = (await response.json()) as {
    content?: string
    encoding?: string
  }

  if (!data.content || data.encoding !== 'base64') {
    throw new Error('unsupported_file_payload')
  }

  return Buffer.from(data.content, 'base64').toString('utf-8')
}

export async function gitDiffForFile(_relPath: string): Promise<string> {
  return ''
}

const SAFE_COMMANDS = new Set([
  'git status --short --branch',
  'git diff --stat',
  'git diff --name-only',
  'npm run build',
])

export async function runSafeCommand(command: string): Promise<{
  code: number
  stdout: string
  stderr: string
}> {
  const normalized = command.trim()
  if (!SAFE_COMMANDS.has(normalized)) {
    return {
      code: 1,
      stdout: '',
      stderr: 'Comando no permitido por seguridad.',
    }
  }

  return {
    code: 0,
    stdout: `Comando aceptado: ${normalized}`,
    stderr:
      'En Vercel web mode no se ejecutan procesos locales; integra un backend worker para ejecucion real.',
  }
}