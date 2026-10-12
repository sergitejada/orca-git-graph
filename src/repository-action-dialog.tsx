import { useEffect, useRef, useState } from 'react'
import { callHost } from './host.js'

function isTerminal(item: unknown): item is { id: string } {
  return Boolean(item && typeof item === 'object' && 'id' in item && typeof item.id === 'string' && item.id.length)
}

export function repositoryCommand(module: string, repo: string, action: 'refresh' | 'fetch'): string {
  if (!module || !repo || !['refresh', 'fetch'].includes(action)) throw new Error('Acción o repositorio inválido.')
  const script = `import(${JSON.stringify(module)}).then(m => m.runRepositoryAction(${JSON.stringify(repo)}, ${JSON.stringify(action)})).then(() => console.log('Git Graph: acción completada.')).catch(e => { console.error(e.stderr ? e.stderr.toString() : e.message); process.exitCode = 1; })`
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(script)))
  const command = `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`
  if (command.length > 4096) throw new Error('La ruta es demasiado larga para enviarla a Orca.')
  return command
}

export function RepositoryActionDialog({ action, repo, module, onClose, onNotice }: {
  action: 'refresh' | 'fetch'
  repo: string
  module: string
  onClose(): void
  onNotice(message: string): void
}) {
  const select = useRef<HTMLSelectElement>(null)
  const [terminals, setTerminals] = useState<string[]>([])
  const [terminal, setTerminal] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const title = action === 'fetch' ? 'Fetch from remote' : 'Refrescar grafo'

  useEffect(() => {
    let current = true
    void callHost<unknown>('workspace.readContext').then(value => {
      if (!current) return
      if (!value || typeof value !== 'object' || !('terminals' in value) || !Array.isArray(value.terminals) || !value.terminals.every(isTerminal)) {
        throw new Error('Orca no ha devuelto una lista de terminales válida.')
      }
      setTerminals(value.terminals.map(item => item.id))
      if (!value.terminals.length) setError('Abre una terminal de shell en Orca y vuelve a intentarlo.')
    }).catch(error => { if (current) setError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [])

  useEffect(() => { if (!loading) select.current?.focus() }, [loading])
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (!loading) onClose() }
    }
    document.addEventListener('keydown', handleEscape, true)
    return () => document.removeEventListener('keydown', handleEscape, true)
  }, [loading, onClose])

  const execute = async () => {
    if (loading || !terminals.includes(terminal)) return
    setLoading(true)
    setError('')
    try {
      const result = await callHost<unknown>('terminal.sendText', { terminalId: terminal, text: repositoryCommand(module, repo, action), enter: true })
      if (!result || typeof result !== 'object' || !('accepted' in result) || result.accepted !== true) throw new Error('La terminal no ha aceptado el comando.')
      onNotice('Comando enviado. Consulta el resultado en la terminal; el grafo se actualizará al terminar.')
      onClose()
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setLoading(false) }
  }

  return <div className="stash-dialog-overlay repository-dialog-overlay"><section className="stash-dialog" role="dialog" aria-modal="true" aria-label={title} onKeyDown={event => {
    if (event.key !== 'Tab') return
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled)')]
    const first = items[0], last = items.at(-1)
    if (!first) { event.preventDefault(); return }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }}>
    <h2>{title}</h2>
    <p>{action === 'fetch' ? 'Descarga commits y referencias de todos los remotos (git fetch --all).' : 'Vuelve a leer los commits, ramas y cambios del repositorio seleccionado.'}</p>
    <label>Terminal de shell<select ref={select} disabled={loading} value={terminal} onChange={event => setTerminal(event.target.value)}><option value="">Selecciona una terminal…</option>{terminals.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
    <p className="detail-muted">Elige una shell libre, sin un agente ni otro proceso ejecutándose. Requiere Node y Git en el PATH.</p>
    <p className="stash-repo">{repo}</p>
    {loading ? <p role="status">Esperando a Orca…</p> : null}
    {error ? <p role="alert" className="error">{error}</p> : null}
    <div className="stash-dialog-buttons"><button type="button" disabled={loading} onClick={onClose}>Cancelar</button><button type="button" disabled={loading || !terminal} onClick={() => { void execute() }}>Ejecutar</button></div>
  </section></div>
}
