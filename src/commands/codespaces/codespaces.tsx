import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { readdir, readFile } from 'fs/promises'
import { relative, resolve } from 'path'
import { Pane } from '../../components/design-system/Pane.js'
import { Box, Text, useInput } from '../../ink.js'
import type { LocalJSXCommandCall, LocalJSXCommandOnDone } from '../../types/command.js'
import { getBranch, getIsGit } from '../../utils/git.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { getExternalEditor } from '../../utils/editor.js'
import { toIDEDisplayName } from '../../utils/ide.js'
import { editFileInEditor } from '../../utils/promptEditor.js'

type TaskAction = {
  key: string
  title: string
  command: string
  mode: 'shell' | 'slash'
  sensitive?: boolean
}

type TreeNode = {
  name: string
  path: string
  kind: 'dir' | 'file'
  children: TreeNode[]
}

type VisibleEntry = {
  name: string
  path: string
  kind: 'dir' | 'file'
  depth: number
}

type DiffLine = {
  text: string
  tone?: 'success' | 'error' | 'warning' | 'dim'
}

type PendingApproval = {
  label: string
  command: string
  mode: 'shell' | 'slash'
}

const MAX_FILES = 120
const MAX_DEPTH = 4
const MAX_DIFF_LINES = 120
const EXPLORER_PAGE_SIZE = 18
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
])

function normalizePath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/')
}

function parentPath(pathValue: string): string | null {
  const normalized = normalizePath(pathValue)
  const idx = normalized.lastIndexOf('/')
  if (idx === -1) return null
  return normalized.slice(0, idx)
}

function trimLines(text: string, maxLines: number): string {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text
  return `${lines.slice(0, maxLines).join('\n')}\n... (${lines.length - maxLines} lines omitted)`
}

function buildTree(files: string[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', kind: 'dir', children: [] }
  const byPath = new Map<string, TreeNode>()
  byPath.set('', root)

  for (const originalFile of files) {
    const file = normalizePath(originalFile)
    const parts = file.split('/').filter(Boolean)
    let currentPath = ''
    let parent = root

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] || ''
      const nextPath = currentPath ? `${currentPath}/${part}` : part
      const isLeaf = i === parts.length - 1
      let node = byPath.get(nextPath)

      if (!node) {
        node = {
          name: part,
          path: nextPath,
          kind: isLeaf ? 'file' : 'dir',
          children: [],
        }
        byPath.set(nextPath, node)
        parent.children.push(node)
      }

      if (!isLeaf && node.kind !== 'dir') {
        node.kind = 'dir'
      }

      parent = node
      currentPath = nextPath
    }
  }

  const sortNodes = (nodes: TreeNode[]): void => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const node of nodes) {
      if (node.kind === 'dir' && node.children.length > 0) {
        sortNodes(node.children)
      }
    }
  }

  sortNodes(root.children)
  return root.children
}

function flattenVisibleEntries(
  nodes: TreeNode[],
  expandedDirs: Set<string>,
  depth = 0,
): VisibleEntry[] {
  const out: VisibleEntry[] = []
  for (const node of nodes) {
    out.push({ name: node.name, path: node.path, kind: node.kind, depth })
    if (node.kind === 'dir' && expandedDirs.has(node.path)) {
      out.push(...flattenVisibleEntries(node.children, expandedDirs, depth + 1))
    }
  }
  return out
}

function buildDiffLines(raw: string, maxLines: number): DiffLine[] {
  const lines = raw.split('\n')
  const limited = lines.slice(0, maxLines)
  const out: DiffLine[] = []

  for (const line of limited) {
    if (line.startsWith('@@')) {
      out.push({ text: line, tone: 'warning' })
      continue
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      out.push({ text: line, tone: 'success' })
      continue
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      out.push({ text: line, tone: 'error' })
      continue
    }
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('---') ||
      line.startsWith('+++')
    ) {
      out.push({ text: line, tone: 'dim' })
      continue
    }
    out.push({ text: line })
  }

  if (lines.length > maxLines) {
    out.push({
      text: `... (${lines.length - maxLines} lines omitted)`,
      tone: 'dim',
    })
  }

  return out
}

function isSensitiveShellCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase()
  if (!normalized) return false
  const riskyPatterns = [
    /(^|\s)sudo(\s|$)/,
    /rm\s+-rf/,
    /git\s+push/,
    /git\s+reset\s+--hard/,
    /git\s+clean\s+-fd/,
    /chmod\s+-r\s+777/,
  ]
  return riskyPatterns.some(rx => rx.test(normalized))
}

async function listWorkspaceFiles(rootDir: string): Promise<string[]> {
  const out: string[] = []

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= MAX_FILES || depth > MAX_DEPTH) return

    let entries: Awaited<ReturnType<typeof readdir>>
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      if (out.length >= MAX_FILES) return
      const absPath = resolve(dir, entry.name)
      const relPath = relative(rootDir, absPath)

      if (!relPath || relPath.startsWith('..')) continue

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await walk(absPath, depth + 1)
      } else if (entry.isFile()) {
        out.push(normalizePath(relPath))
      }
    }
  }

  await walk(rootDir, 0)
  return out
}

async function readFilePreview(rootDir: string, filePath: string): Promise<string> {
  try {
    const fullPath = resolve(rootDir, filePath)
    const raw = await readFile(fullPath, 'utf-8')
    return trimLines(raw, 80)
  } catch {
    return 'Unable to read file preview.'
  }
}

function CodespacesPanel({ onDone }: { onDone: LocalJSXCommandOnDone }): React.ReactNode {
  const rootDir = process.cwd()
  const [activePane, setActivePane] = useState<'explorer' | 'tasks'>('explorer')
  const [selectedExplorerPath, setSelectedExplorerPath] = useState<string | null>(null)
  const [explorerOffset, setExplorerOffset] = useState(0)
  const [selectedTask, setSelectedTask] = useState(0)
  const [files, setFiles] = useState<string[]>([])
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [changedFiles, setChangedFiles] = useState<Set<string>>(new Set())
  const [diffLines, setDiffLines] = useState<DiffLine[]>([
    { text: 'Loading file diff...' },
  ])
  const [taskLogs, setTaskLogs] = useState<string[]>(['Task console ready.'])
  const [isRunningTask, setIsRunningTask] = useState(false)
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)
  const [isCustomCommandMode, setIsCustomCommandMode] = useState(false)
  const [customCommandBuffer, setCustomCommandBuffer] = useState('')
  const [isGitRepo, setIsGitRepo] = useState(false)
  const [isRefreshingFiles, setIsRefreshingFiles] = useState(false)
  const [editorName, setEditorName] = useState('IDE')
  const [fileRefreshTick, setFileRefreshTick] = useState(0)
  const [branchInfo, setBranchInfo] = useState('loading...')

  const tree = useMemo(() => buildTree(files), [files])
  const visibleEntries = useMemo(
    () => flattenVisibleEntries(tree, expandedDirs),
    [tree, expandedDirs],
  )
  const selectedExplorerIndex = useMemo(() => {
    if (visibleEntries.length === 0) return -1
    if (!selectedExplorerPath) return 0
    const idx = visibleEntries.findIndex(v => v.path === selectedExplorerPath)
    return idx >= 0 ? idx : 0
  }, [selectedExplorerPath, visibleEntries])
  const selectedEntry =
    selectedExplorerIndex >= 0 ? visibleEntries[selectedExplorerIndex] : null
  const currentFile = selectedEntry?.kind === 'file' ? selectedEntry.path : null

  const taskActions = useMemo<TaskAction[]>(
    () => [
      {
        key: '1',
        title: 'Git status',
        command: 'git status --short --branch',
        mode: 'shell',
      },
      {
        key: '2',
        title: 'Run tests',
        command: 'bun test',
        mode: 'shell',
      },
      {
        key: '3',
        title: 'Run review command',
        command: '/review',
        mode: 'slash',
      },
      {
        key: '4',
        title: 'Commit changes (sensitive)',
        command: '/commit',
        mode: 'slash',
        sensitive: true,
      },
      {
        key: '5',
        title: 'Push + PR flow (sensitive)',
        command: '/commit-push-pr',
        mode: 'slash',
        sensitive: true,
      },
      {
        key: '6',
        title: 'Open status screen',
        command: '/status',
        mode: 'slash',
      },
      {
        key: '7',
        title: 'Run custom shell command',
        command: ':custom',
        mode: 'shell',
      },
    ],
    [],
  )

  useEffect(() => {
    const externalEditor = getExternalEditor()
    if (externalEditor) {
      setEditorName(toIDEDisplayName(externalEditor))
    }
  }, [])

  useEffect(() => {
    const bootstrap = async (): Promise<void> => {
      try {
        const isGit = await getIsGit()
        setIsGitRepo(isGit)

        if (!isGit) {
          setBranchInfo('not a git repository')
        } else {
          const branch = await getBranch()
          setBranchInfo(branch || 'detached HEAD')
        }

        await refreshWorkspace(isGit, true)
      } catch {
        setBranchInfo('unavailable')
      }
    }

    bootstrap().catch(() => {
      setBranchInfo('unavailable')
    })
  }, [])

  useEffect(() => {
    if (selectedExplorerIndex < 0 || visibleEntries.length === 0) {
      setExplorerOffset(0)
      return
    }

    setExplorerOffset(prev => {
      if (selectedExplorerIndex < prev) return selectedExplorerIndex
      const maxVisibleIndex = prev + EXPLORER_PAGE_SIZE - 1
      if (selectedExplorerIndex > maxVisibleIndex) {
        return selectedExplorerIndex - EXPLORER_PAGE_SIZE + 1
      }
      return prev
    })
  }, [selectedExplorerIndex, visibleEntries.length])

  useEffect(() => {
    const loadDiffForSelection = async (): Promise<void> => {
      if (!selectedEntry) {
        setDiffLines([{ text: 'No files found in workspace explorer.' }])
        return
      }

      if (selectedEntry.kind === 'dir') {
        const descendantChangedCount = Array.from(changedFiles).filter(file =>
          file.startsWith(`${selectedEntry.path}/`),
        ).length
        setDiffLines([
          { text: `Directory: ${selectedEntry.path}` },
          { text: `${descendantChangedCount} changed files under this folder`, tone: 'dim' },
          { text: 'Use Right Arrow to expand and Left Arrow to collapse.', tone: 'dim' },
          { text: 'Select a file to view live diff hunks.', tone: 'dim' },
        ])
        return
      }

      if (!isGitRepo) {
        const preview = await readFilePreview(rootDir, selectedEntry.path)
        setDiffLines(
          preview.split('\n').map(line => ({ text: line })),
        )
        return
      }

      const result = await execFileNoThrow(
        'git',
        ['--no-optional-locks', 'diff', 'HEAD', '--', selectedEntry.path],
        { timeout: 5000, preserveOutputOnError: true },
      )

      if (result.code !== 0) {
        setDiffLines([
          { text: `Unable to load diff for ${selectedEntry.path}.`, tone: 'error' },
          { text: result.stderr || result.error || '', tone: 'dim' },
        ])
        return
      }

      if (!result.stdout.trim()) {
        const preview = await readFilePreview(rootDir, selectedEntry.path)
        const summary = `No local diff for ${selectedEntry.path}.`
        setDiffLines([
          { text: summary, tone: 'dim' },
          ...preview.split('\n').slice(0, MAX_DIFF_LINES - 1).map(line => ({ text: line })),
        ])
        return
      }

      setDiffLines(buildDiffLines(result.stdout, MAX_DIFF_LINES))
    }

    loadDiffForSelection().catch(() => {
      setDiffLines([{ text: 'Unable to load selection preview.', tone: 'error' }])
    })
  }, [
    changedFiles,
    fileRefreshTick,
    isGitRepo,
    rootDir,
    selectedEntry,
  ])

  async function refreshWorkspace(gitEnabled: boolean, initialize = false): Promise<void> {
    setIsRefreshingFiles(true)

    const nextFiles = await listWorkspaceFiles(rootDir)
    setFiles(nextFiles)

    if (initialize) {
      const initialExpanded = new Set<string>()
      const topLevel = new Set(nextFiles.map(f => (f.includes('/') ? f.split('/')[0] || '' : '')))
      for (const folder of topLevel) {
        if (folder) initialExpanded.add(folder)
      }
      setExpandedDirs(initialExpanded)
      setSelectedExplorerPath(nextFiles[0] || null)
    } else if (selectedExplorerPath) {
      const stillExists = nextFiles.some(file => file === selectedExplorerPath || file.startsWith(`${selectedExplorerPath}/`))
      if (!stillExists) {
        setSelectedExplorerPath(nextFiles[0] || null)
      }
    }

    if (!gitEnabled) {
      setChangedFiles(new Set())
      setIsRefreshingFiles(false)
      return
    }

    const [tracked, untracked] = await Promise.all([
      execFileNoThrow('git', ['--no-optional-locks', 'diff', 'HEAD', '--name-only'], {
        timeout: 5000,
        preserveOutputOnError: true,
      }),
      execFileNoThrow('git', ['--no-optional-locks', 'ls-files', '--others', '--exclude-standard'], {
        timeout: 5000,
        preserveOutputOnError: true,
      }),
    ])

    const changed = new Set<string>()
    tracked.stdout
      .split('\n')
      .map(v => v.trim())
      .filter(Boolean)
      .forEach(v => changed.add(v))
    untracked.stdout
      .split('\n')
      .map(v => v.trim())
      .filter(Boolean)
      .forEach(v => changed.add(v))

    setChangedFiles(changed)
    setIsRefreshingFiles(false)
  }

  function appendTaskLog(line: string): void {
    const stamp = new Date().toLocaleTimeString()
    setTaskLogs(prev => [...prev.slice(-7), `[${stamp}] ${line}`])
  }

  async function runShellCommand(command: string): Promise<void> {
    if (isRunningTask) return

    setIsRunningTask(true)
    appendTaskLog(`Running shell task: ${command}`)
    const result = await execFileNoThrow('bash', ['-lc', command], {
      timeout: 120000,
      preserveOutputOnError: true,
    })

    if (result.code === 0) {
      appendTaskLog(`Completed: exit code ${result.code}`)
      if (result.stdout.trim()) {
        appendTaskLog(trimLines(result.stdout, 8))
      }
    } else {
      appendTaskLog(`Failed: exit code ${result.code}`)
      if (result.stderr.trim()) {
        appendTaskLog(trimLines(result.stderr, 8))
      }
    }

    setIsRunningTask(false)
    void refreshWorkspace(isGitRepo)
  }

  async function executeTask(task: TaskAction): Promise<void> {
    if (task.command === ':custom') {
      setIsCustomCommandMode(true)
      setCustomCommandBuffer('')
      appendTaskLog('Custom command mode enabled. Type command and press Enter.')
      return
    }

    if (task.mode === 'slash') {
      appendTaskLog(`Launching command ${task.command}`)
      onDone(`Launching ${task.command}...`, {
        nextInput: task.command,
        submitNextInput: true,
      })
      return
    }

    await runShellCommand(task.command)
  }

  function requestApprovalForAction(action: PendingApproval): void {
    setPendingApproval(action)
    appendTaskLog(`Approval requested for: ${action.label}`)
  }

  async function openSelectedFileInEditor(): Promise<void> {
    if (!selectedEntry || selectedEntry.kind !== 'file') {
      appendTaskLog('Select a file in Explorer before opening editor.')
      return
    }

    const editor = getExternalEditor()
    if (!editor) {
      appendTaskLog('No external editor configured (set VISUAL or EDITOR).')
      return
    }

    const absolutePath = resolve(rootDir, selectedEntry.path)
    appendTaskLog(`Opening ${selectedEntry.path} in ${toIDEDisplayName(editor)}`)
    const result = editFileInEditor(absolutePath)
    if (result.error) {
      appendTaskLog(`Editor error: ${result.error}`)
      return
    }

    appendTaskLog(`Closed editor for ${selectedEntry.path}`)
    setFileRefreshTick(prev => prev + 1)
    void refreshWorkspace(isGitRepo)
  }

  useInput((input, key) => {
    const keyInput = input.toLowerCase()

    if (isCustomCommandMode) {
      if (key.escape) {
        setIsCustomCommandMode(false)
        setCustomCommandBuffer('')
        appendTaskLog('Custom command cancelled.')
        return
      }
      if (key.return) {
        const command = customCommandBuffer.trim()
        setIsCustomCommandMode(false)
        setCustomCommandBuffer('')
        if (!command) {
          appendTaskLog('Custom command was empty. Nothing executed.')
          return
        }
        if (isSensitiveShellCommand(command)) {
          requestApprovalForAction({
            label: `Custom command: ${command}`,
            command,
            mode: 'shell',
          })
          return
        }
        void runShellCommand(command)
        return
      }
      if (key.backspace || key.delete) {
        setCustomCommandBuffer(prev => prev.slice(0, -1))
        return
      }
      if (input && !key.ctrl && !key.meta && !key.escape) {
        setCustomCommandBuffer(prev => `${prev}${input}`)
      }
      return
    }

    if (pendingApproval) {
      if (key.return || keyInput === 'a' || keyInput === 'y') {
        const approved = pendingApproval
        setPendingApproval(null)
        if (approved.mode === 'slash') {
          appendTaskLog(`Launching command ${approved.command}`)
          onDone(`Launching ${approved.command}...`, {
            nextInput: approved.command,
            submitNextInput: true,
          })
        } else {
          void runShellCommand(approved.command)
        }
        return
      }
      if (key.escape || keyInput === 'n') {
        appendTaskLog(`Cancelled sensitive action: ${pendingApproval.label}`)
        setPendingApproval(null)
        return
      }
      return
    }

    if (key.escape || keyInput === 'q') {
      onDone('Closed Codespaces workspace view.')
      return
    }

    if (key.tab) {
      setActivePane(prev => (prev === 'explorer' ? 'tasks' : 'explorer'))
      return
    }

    if (keyInput === ':') {
      setActivePane('tasks')
      setIsCustomCommandMode(true)
      setCustomCommandBuffer('')
      appendTaskLog('Custom command mode enabled. Type command and press Enter.')
      return
    }

    if (keyInput === 'r') {
      void refreshWorkspace(isGitRepo)
      return
    }

    if (activePane === 'explorer' && keyInput === 'o') {
      void openSelectedFileInEditor()
      return
    }

    if (key.upArrow || keyInput === 'k') {
      if (activePane === 'explorer') {
        if (visibleEntries.length === 0) return
        const next =
          selectedExplorerIndex <= 0
            ? visibleEntries.length - 1
            : selectedExplorerIndex - 1
        setSelectedExplorerPath(visibleEntries[next]?.path || null)
      } else {
        setSelectedTask(prev => (prev === 0 ? taskActions.length - 1 : prev - 1))
      }
      return
    }

    if (key.downArrow || keyInput === 'j') {
      if (activePane === 'explorer') {
        if (visibleEntries.length === 0) return
        const next =
          selectedExplorerIndex >= visibleEntries.length - 1
            ? 0
            : selectedExplorerIndex + 1
        setSelectedExplorerPath(visibleEntries[next]?.path || null)
      } else {
        setSelectedTask(prev => (prev === taskActions.length - 1 ? 0 : prev + 1))
      }
      return
    }

    if (activePane === 'explorer' && key.rightArrow) {
      if (!selectedEntry) return
      if (selectedEntry.kind === 'dir') {
        setExpandedDirs(prev => {
          const next = new Set(prev)
          next.add(selectedEntry.path)
          return next
        })
      }
      return
    }

    if (activePane === 'explorer' && key.leftArrow) {
      if (!selectedEntry) return
      if (selectedEntry.kind === 'dir' && expandedDirs.has(selectedEntry.path)) {
        setExpandedDirs(prev => {
          const next = new Set(prev)
          next.delete(selectedEntry.path)
          return next
        })
        return
      }
      const parent = parentPath(selectedEntry.path)
      if (parent) {
        setSelectedExplorerPath(parent)
      }
      return
    }

    if (key.return) {
      if (activePane === 'explorer') {
        if (!selectedEntry) return
        if (selectedEntry.kind === 'dir') {
          setExpandedDirs(prev => {
            const next = new Set(prev)
            if (next.has(selectedEntry.path)) next.delete(selectedEntry.path)
            else next.add(selectedEntry.path)
            return next
          })
          return
        }
        void openSelectedFileInEditor()
        return
      }

      if (activePane === 'tasks') {
        const task = taskActions[selectedTask]
        if (!task) return
        if (task.sensitive) {
          requestApprovalForAction({
            label: task.title,
            command: task.command,
            mode: task.mode,
          })
          return
        }
        void executeTask(task)
      }
      return
    }

    if (activePane === 'tasks') {
      const taskByKey = taskActions.find(item => item.key === keyInput)
      if (!taskByKey) return
      const idx = taskActions.findIndex(item => item.key === keyInput)
      if (idx >= 0) setSelectedTask(idx)
      if (taskByKey.sensitive) {
        requestApprovalForAction({
          label: taskByKey.title,
          command: taskByKey.command,
          mode: taskByKey.mode,
        })
        return
      }
      void executeTask(taskByKey)
    }
  })

  const explorerWindow = visibleEntries.slice(
    explorerOffset,
    explorerOffset + EXPLORER_PAGE_SIZE,
  )

  return (
    <Pane color="ide">
      <Box flexDirection="column" gap={1}>
        <Text bold>Codespaces-Style Copilot Workspace (Pro)</Text>
        <Text dimColor>
          Repo: {rootDir} | Branch: {branchInfo}
        </Text>
        <Text dimColor>
          Controls: Tab pane, arrows or j/k navigate, Left/Right fold tree, Enter open/toggle, o open editor, : custom command, r refresh, q close
        </Text>

        <Box>
          <Box flexDirection="column" width={52}>
            <Text bold color={activePane === 'explorer' ? 'success' : undefined}>
              Explorer {isRefreshingFiles ? '(refreshing...)' : ''}
            </Text>
            {visibleEntries.length === 0 ? (
              <Text dimColor>No files to display</Text>
            ) : (
              explorerWindow.map((entry, index) => {
                const absoluteIndex = explorerOffset + index
                const isSelected = absoluteIndex === selectedExplorerIndex
                const indentation = ' '.repeat(entry.depth * 2)
                const foldMarker =
                  entry.kind === 'dir'
                    ? expandedDirs.has(entry.path)
                      ? '▾'
                      : '▸'
                    : ' '
                const changedMark =
                  entry.kind === 'file'
                    ? changedFiles.has(entry.path)
                      ? '*'
                      : ' '
                    : Array.from(changedFiles).some(file =>
                          file.startsWith(`${entry.path}/`),
                        )
                      ? '*'
                      : ' '

                return (
                  <Text key={entry.path} color={activePane === 'explorer' && isSelected ? 'success' : undefined}>
                    {activePane === 'explorer' && isSelected ? '>' : ' '} {changedMark} {indentation}
                    {foldMarker} {entry.name}
                  </Text>
                )
              })
            )}
            <Text dimColor>
              Rows {Math.min(explorerOffset + 1, Math.max(visibleEntries.length, 1))}-
              {Math.min(explorerOffset + EXPLORER_PAGE_SIZE, visibleEntries.length)} of {visibleEntries.length}
            </Text>
            <Text dimColor>Editor: {editorName}</Text>
          </Box>

          <Box flexDirection="column" flexGrow={1} paddingX={1}>
            <Text bold>
              Live Diff / Preview {selectedEntry ? `- ${selectedEntry.path}` : ''}
            </Text>
            {diffLines.slice(0, 36).map((line, index) => (
              <Text
                key={`${index}-${line.text}`}
                color={
                  line.tone === 'success' ||
                  line.tone === 'error' ||
                  line.tone === 'warning'
                    ? line.tone
                    : undefined
                }
                dimColor={line.tone === 'dim'}
              >
                {line.text}
              </Text>
            ))}
          </Box>

          <Box flexDirection="column" width={52}>
            <Text bold color={activePane === 'tasks' ? 'success' : undefined}>
              Task Console
            </Text>
            {taskActions.map((item, index) => (
              <Box key={item.key}>
                <Text color={activePane === 'tasks' && index === selectedTask ? 'success' : undefined}>
                  {activePane === 'tasks' && index === selectedTask ? '>' : ' '} [{item.key}] {item.title}
                </Text>
              </Box>
            ))}
            <Text dimColor>{isRunningTask ? 'Running task...' : 'Idle'}</Text>
            {taskLogs.slice(-5).map(log => (
              <Text key={log} dimColor>
                {log}
              </Text>
            ))}
          </Box>
        </Box>

        {isCustomCommandMode ? (
          <Box flexDirection="column">
            <Text color="warning" bold>
              Custom command mode
            </Text>
            <Text>$ {customCommandBuffer || '_'}</Text>
            <Text dimColor>Type command and press Enter. Esc cancels.</Text>
          </Box>
        ) : null}

        {pendingApproval ? (
          <Box flexDirection="column">
            <Text color="warning" bold>
              Sensitive action requires approval
            </Text>
            <Text>
              {pendingApproval.label} - {pendingApproval.command}
            </Text>
            <Text dimColor>
              Press A or Y to approve, N or Esc to cancel.
            </Text>
          </Box>
        ) : null}
      </Box>
    </Pane>
  )
}

export const call: LocalJSXCommandCall = async onDone => {
  return <CodespacesPanel onDone={onDone} />
}