import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { callHost, copyText } from './host.js'
import { stashCommand, type StashAction } from './stash-actions.js'

const actions: { label: string; action: StashAction | 'copy-name' | 'copy-hash' }[] = [
  { label: 'Apply Stash…', action: 'apply' },
  { label: 'Create Branch from Stash…', action: 'branch' },
  { label: 'Pop Stash…', action: 'pop' },
  { label: 'Drop Stash…', action: 'drop' },
  { label: 'Copy Stash Name to Clipboard', action: 'copy-name' },
  { label: 'Copy Stash Hash to Clipboard', action: 'copy-hash' },
]

interface StashMenuProps {
  name: string
  hash: string
  repo: string
  left: number
  top: number
  onClose(): void
  onNotice(message: string): void
}

export function StashMenu({ name, hash, repo, left, top, onClose, onNotice }: StashMenuProps) {
  const menu = useRef<HTMLDivElement>(null)
  const branchInput = useRef<HTMLInputElement>(null)
  const terminalSelect = useRef<HTMLSelectElement>(null)
  const [position, setPosition] = useState({ left, top })
  const [action, setAction] = useState<StashAction | null>(null)
  const [terminals, setTerminals] = useState<string[]>([])
  const [terminal, setTerminal] = useState('')
  const [branch, setBranch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!action || loading) return
    if (action === 'branch') branchInput.current?.focus()
    else terminalSelect.current?.focus()
  }, [action, loading])

  useLayoutEffect(() => {
    const element = menu.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    setPosition({ left: Math.max(4, Math.min(left, window.innerWidth - rect.width - 4)), top: Math.max(4, Math.min(top, window.innerHeight - rect.height - 4)) })
    element.querySelector<HTMLButtonElement>('button')?.focus()
  }, [left, top])

  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!action && !menu.current?.contains(event.target as Node)) onClose() }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (!loading) onClose() }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', handleEscape, true)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', handleEscape, true) }
  }, [action, loading, onClose])

  const choose = async (selected: typeof actions[number]['action']) => {
    if (selected === 'copy-name' || selected === 'copy-hash') {
      const text = selected === 'copy-name' ? name : hash
      try { await copyText(text); onNotice(selected === 'copy-name' ? 'Nombre del stash copiado.' : 'Hash del stash copiado.') }
      catch (error) { onNotice(`${error instanceof Error ? error.message : String(error)} ${text}`) }
      onClose()
      return
    }
    setAction(selected)
    setLoading(true)
    try {
      const context = await callHost<{ terminals: { id: string }[] } | null>('workspace.readContext')
      setTerminals(context?.terminals.map(item => item.id) || [])
      if (!context?.terminals.length) setError('Abre una terminal de shell en Orca y vuelve a intentarlo.')
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setLoading(false) }
  }

  const execute = async () => {
    if (!action || !terminal || loading) return
    setLoading(true)
    setError('')
    try {
      const text = stashCommand(repo, hash, action, branch)
      const result = await callHost<{ accepted: boolean }>('terminal.sendText', { terminalId: terminal, text, enter: true })
      if (!result.accepted) throw new Error('La terminal no ha aceptado el comando.')
      onNotice('Comando enviado. Consulta el resultado en la terminal; el grafo se refrescará automáticamente.')
      onClose()
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setLoading(false) }
  }

  if (action) return <div className="stash-dialog-overlay"><section className="stash-dialog" role="dialog" aria-modal="true" aria-label={actions.find(item => item.action === action)?.label} onKeyDown={event => {
    if (event.key !== 'Tab') return
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input, select')]
    const first = items[0], last = items.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }}>
    <h2>{actions.find(item => item.action === action)?.label}</h2>
    <p><b>{name}</b> · <code>{hash.slice(0, 8)}</code></p>
    <p>{action === 'drop' ? 'Se eliminará este stash.' : action === 'pop' ? 'Se aplicarán sus cambios y se eliminará el stash si la aplicación termina correctamente.' : action === 'branch' ? 'Se creará una rama desde su commit base, se aplicará el stash y se eliminará si la aplicación termina correctamente.' : 'Se aplicarán sus cambios y se conservará el stash.'}</p>
    {action === 'branch' ? <label>Nueva rama<input ref={branchInput} value={branch} onChange={event => setBranch(event.target.value)} /></label> : null}
    <label>Terminal de shell<select ref={terminalSelect} value={terminal} onChange={event => setTerminal(event.target.value)} disabled={loading}><option value="">Selecciona una terminal…</option>{terminals.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
    <p className="detail-muted">Elige una shell libre, sin un agente ni otro proceso ejecutándose. La acción usa Git y Node en el repositorio mostrado.</p>
    <p className="stash-repo">{repo}</p>
    {loading ? <p role="status">Esperando a Orca…</p> : null}
    {error ? <p role="alert" className="error">{error}</p> : null}
    <div className="stash-dialog-buttons"><button type="button" disabled={loading} onClick={onClose}>Cancelar</button><button type="button" disabled={loading || !terminal || (action === 'branch' && !branch.trim())} onClick={() => { void execute() }}>Ejecutar</button></div>
  </section></div>

  return <div ref={menu} className="stash-menu" role="menu" aria-label={`Acciones de ${name}`} style={position} onKeyDown={event => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : event.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1
    if (next >= 0) { event.preventDefault(); buttons[next].focus() }
    if (event.key === 'Tab') onClose()
  }}>{actions.map((item, index) => <button type="button" role="menuitem" key={item.action} className={index === 4 ? 'stash-menu-separator' : undefined} onClick={() => { void choose(item.action) }}>{item.label}</button>)}</div>
}
