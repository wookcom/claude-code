import { execFile } from 'child_process'
import type { Dirent } from 'fs'
import { readdir, readFile, stat } from 'fs/promises'
import path from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const MAX_FILES = 500
const MAX_DEPTH = 6
const MAX_READ_BYTES = 220_000

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
])

export const workspaceRoot = process.cwd()

export function sanitizePath(input: string): string | null {
  if (!input) return null
  const cleaned = input.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned || cleaned.includes('..')) return null
  const full = path.resolve(workspaceRoot, cleaned)
  if (!full.startsWith(workspaceRoot)) return null
  return cleaned
}

export async function listWorkspaceFiles(): Promise<string[]> {
  const out: string[] = []

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= MAX_FILES || depth > MAX_DEPTH) return
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      if (out.length >= MAX_FILES) return
      const abs = path.resolve(dir, entry.name)
      const rel = path.relative(workspaceRoot, abs).replace(/\\/g, '/')
      if (!rel || rel.startsWith('..')) continue

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await walk(abs, depth + 1)
      } else if (entry.isFile()) {
        out.push(rel)
      }
    }
  }

  await walk(workspaceRoot, 0)
  return out
}

export async function readWorkspaceFile(relPath: string): Promise<string> {
  const safe = sanitizePath(relPath)
  if (!safe) throw new Error('invalid_path')
  const full = path.resolve(workspaceRoot, safe)
  const fileStat = await stat(full)
  if (!fileStat.isFile()) throw new Error('not_file')
  if (fileStat.size > MAX_READ_BYTES) {
    throw new Error('file_too_large')
  }
  return readFile(full, 'utf-8')
}

export async function gitDiffForFile(relPath: string): Promise<string> {
  const safe = sanitizePath(relPath)
  if (!safe) throw new Error('invalid_path')

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['--no-optional-locks', 'diff', 'HEAD', '--', safe],
      {
        cwd: workspaceRoot,
        timeout: 8_000,
        maxBuffer: 2_000_000,
      },
    )
    return stdout
  } catch {
    return ''
  }
}

const SAFE_COMMANDS = new Set([
  'git status --short --branch',
  'git status',
  'git diff --stat',
  'git diff --name-only',
  'npm test',
  'npm run build',
  'bun test',
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
      stderr:
        'Comando no permitido por seguridad. Usa uno de los comandos predefinidos.',
    }
  }

  const [bin, ...args] = normalized.split(' ')
  if (!bin) {
    return { code: 1, stdout: '', stderr: 'Comando invalido' }
  }

  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd: workspaceRoot,
      timeout: 20_000,
      maxBuffer: 2_000_000,
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number }
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? 'Fallo al ejecutar comando',
    }
  }
}