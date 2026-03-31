'use client'

import { useEffect, useMemo, useState } from 'react'

type CommandResult = {
  code: number
  stdout: string
  stderr: string
}

const PRESET_COMMANDS = [
  'git status --short --branch',
  'git diff --stat',
  'git diff --name-only',
  'npm run build',
]

function classifyLine(line: string): string {
  if (line.startsWith('@@')) return 'lineHunk'
  if (line.startsWith('+') && !line.startsWith('+++')) return 'lineAdded'
  if (line.startsWith('-') && !line.startsWith('---')) return 'lineRemoved'
  if (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('---') ||
    line.startsWith('+++')
  ) {
    return 'lineMuted'
  }
  return ''
}

export default function Page() {
  const [files, setFiles] = useState<string[]>([])
  const [selectedFile, setSelectedFile] = useState<string>('')
  const [changedFiles, setChangedFiles] = useState<Set<string>>(new Set())
  const [diffText, setDiffText] = useState<string>('Cargando diff...')
  const [command, setCommand] = useState<string>(PRESET_COMMANDS[0] ?? '')
  const [logs, setLogs] = useState<string[]>([])
  const [loadingFiles, setLoadingFiles] = useState<boolean>(true)
  const [running, setRunning] = useState<boolean>(false)

  async function refreshFiles(): Promise<void> {
    setLoadingFiles(true)
    try {
      const response = await fetch('/api/files')
      const data = (await response.json()) as { files?: string[] }
      const nextFiles = data.files ?? []
      setFiles(nextFiles)
      if (!selectedFile && nextFiles.length > 0) {
        setSelectedFile(nextFiles[0] ?? '')
      }
    } finally {
      setLoadingFiles(false)
    }
  }

  async function refreshDiff(target: string): Promise<void> {
    if (!target) {
      setDiffText('No hay archivo seleccionado.')
      return
    }
    const encoded = encodeURIComponent(target)
    const diffResponse = await fetch(`/api/diff?path=${encoded}`)
    const diffData = (await diffResponse.json()) as { diff?: string }
    const diff = diffData.diff?.trim()

    if (diff) {
      setDiffText(diff)
      return
    }

    const fileResponse = await fetch(`/api/file?path=${encoded}`)
    const fileData = (await fileResponse.json()) as { content?: string }
    const preview = fileData.content ?? 'No se pudo cargar preview.'
    setDiffText(`Sin diff local para ${target}.\n\n${preview.slice(0, 12000)}`)
  }

  function appendLog(message: string): void {
    const stamp = new Date().toLocaleTimeString()
    setLogs(prev => [...prev.slice(-70), `[${stamp}] ${message}`])
  }

  async function runCommand(commandText: string): Promise<void> {
    if (!commandText.trim()) return
    setRunning(true)
    appendLog(`$ ${commandText}`)

    try {
      const response = await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: commandText }),
      })
      const result = (await response.json()) as CommandResult
      if (result.stdout?.trim()) appendLog(result.stdout.trim())
      if (result.stderr?.trim()) appendLog(result.stderr.trim())
      appendLog(`Exit code: ${result.code}`)

      if (
        commandText.startsWith('git status') ||
        commandText.startsWith('git diff')
      ) {
        void refreshFiles()
        if (selectedFile) void refreshDiff(selectedFile)
      }
    } catch {
      appendLog('Error al ejecutar comando.')
    } finally {
      setRunning(false)
    }
  }

  useEffect(() => {
    void refreshFiles()
  }, [])

  useEffect(() => {
    if (selectedFile) {
      void refreshDiff(selectedFile)
    }
  }, [selectedFile])

  useEffect(() => {
    const nextChanged = new Set<string>()
    const lines = diffText.split('\n')
    for (const line of lines) {
      if (line.startsWith('diff --git')) {
        const parts = line.split(' b/')
        if (parts[1]) nextChanged.add(parts[1])
      }
    }
    setChangedFiles(nextChanged)
  }, [diffText])

  const diffLines = useMemo(() => diffText.split('\n'), [diffText])

  return (
    <main className="app">
      <section className="header">
        <h1 className="title">Copilot Workspace Web (Real)</h1>
        <p className="sub">
          UI web funcional sobre este repositorio: explorer, diff real por archivo y
          consola de tareas.
        </p>
        <div className="status">
          Estado: <strong>{loadingFiles ? 'Sincronizando archivos...' : 'Listo'}</strong>
        </div>
      </section>

      <section className="grid">
        <article className="panel">
          <div className="panelHeader">
            <span>Explorer</span>
            <button className="btn" onClick={() => void refreshFiles()}>
              Refrescar
            </button>
          </div>
          <div className="panelBody">
            <div className="list">
              {files.map(file => (
                <button
                  key={file}
                  className={`fileItem ${selectedFile === file ? 'active' : ''}`}
                  onClick={() => setSelectedFile(file)}
                >
                  {changedFiles.has(file) ? <span className="badge">*</span> : null}
                  {file}
                </button>
              ))}
              {files.length === 0 ? <div className="muted">No hay archivos.</div> : null}
            </div>
          </div>
        </article>

        <article className="panel">
          <div className="panelHeader">
            <span>Live Diff / Preview</span>
            <span className="muted">{selectedFile || 'sin seleccion'}</span>
          </div>
          <div className="panelBody">
            <pre className="diffBox">
              {diffLines.map((line, index) => (
                <div key={`${index}-${line}`} className={classifyLine(line)}>
                  {line}
                </div>
              ))}
            </pre>
          </div>
        </article>

        <article className="panel">
          <div className="panelHeader">
            <span>Task Console</span>
            <span className="muted">Comandos permitidos</span>
          </div>
          <div className="panelBody">
            <div className="actions">
              {PRESET_COMMANDS.map(cmd => (
                <button key={cmd} className="btn" onClick={() => void runCommand(cmd)}>
                  {cmd}
                </button>
              ))}
              <button
                className="btn btnWarn"
                onClick={() =>
                  window.alert(
                    'Por seguridad, /commit y /push no se ejecutan en modo web directo.',
                  )
                }
              >
                Acciones sensibles protegidas
              </button>
            </div>

            <div className="inputRow">
              <input
                className="input"
                value={command}
                onChange={event => setCommand(event.target.value)}
                placeholder="Escribe comando permitido..."
              />
              <button
                className="btn"
                disabled={running}
                onClick={() => void runCommand(command)}
              >
                {running ? 'Ejecutando...' : 'Ejecutar'}
              </button>
            </div>

            <pre className="console">{logs.join('\n') || 'Sin eventos aun.'}</pre>
          </div>
        </article>
      </section>
    </main>
  )
}