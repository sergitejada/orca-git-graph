import { useRef, useState } from 'react'
import type { PanelRow } from './types.js'

interface DetailsProps {
  row: PanelRow
  loadedHashes: Set<string>
  onClose(): void
  onJump(hash: string): void
}

export function Details({ row, loadedHashes, onClose, onJump }: DetailsProps) {
  const { commit } = row
  const hashInput = useRef<HTMLInputElement>(null)
  const [copyMessage, setCopyMessage] = useState('')

  const copyHash = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(commit.hash)
      setCopyMessage('Hash copiado')
    } catch {
      hashInput.current?.focus()
      hashInput.current?.select()
      let copied = false
      try { copied = document.execCommand('copy') } catch { /* El hash sigue seleccionado para copiarlo manualmente. */ }
      setCopyMessage(copied ? 'Hash copiado' : 'Hash seleccionado: pulsa Ctrl+C.')
    }
  }

  return <aside id="commit-details" className="details" aria-label="Detalles del commit">
    <div className="details-heading"><h2>{commit.wip ? 'Cambios sin confirmar' : commit.stash ? `Stash ${commit.stash}` : 'Detalles del commit'}</h2><button type="button" onClick={onClose} aria-label="Cerrar detalles" title="Cerrar detalles (Esc)">✕</button></div>
    <h3>{commit.subject}</h3>
    {commit.wip ? <>
      <p className="detail-muted">{commit.changes.length} ficheros · {commit.changes.filter(change => change.x !== ' ' && change.x !== '?').length} preparados · {commit.changes.filter(change => change.y !== ' ' && change.y !== '?').length} sin preparar · {commit.changes.filter(change => change.x === '?').length} sin seguimiento</p>
      <ul className="changes-list">{commit.changes.map((change, index) => <li key={`${change.path}-${index}`}><code title="Estado del índice y del árbol de trabajo">{change.x}{change.y}</code><span title={change.path}>{change.path}</span></li>)}</ul>
      <p className="detail-muted">M: modificado · A: añadido · D: eliminado · R: renombrado · U: conflicto · ??: sin seguimiento</p>
    </> : <>
      <dl><dt>Autor</dt><dd>{commit.author}{commit.authorEmail ? <span className="detail-muted"> &lt;{commit.authorEmail}&gt;</span> : null}</dd><dt>Fecha</dt><dd>{commit.dateLabel}</dd></dl>
      <div className="hash-control"><input ref={hashInput} aria-label="Hash completo" readOnly value={commit.hash} onFocus={event => event.target.select()} /><button type="button" onClick={() => { void copyHash() }}>Copiar hash</button></div>
      <span className="copy-message" role="status">{copyMessage}</span>
      {commit.refs.length ? <div className="detail-refs">{commit.refs.map(ref => <span key={ref}>{ref}</span>)}</div> : null}
      <pre className="commit-message">{commit.message || commit.subject}</pre>
    </>}
    {commit.parents.length ? <div className="parents"><h4>{commit.parents.length > 1 ? `Padres (${commit.parents.length}) · merge` : 'Padre'}</h4>{commit.parents.map(parent => loadedHashes.has(parent)
      ? <button type="button" key={parent} title={`Ver commit padre ${parent}`} onClick={() => onJump(parent)}>{parent.slice(0, 8)}</button>
      : <code key={parent} title={`${parent} · fuera del historial cargado`}>{parent.slice(0, 8)}</code>)}</div> : null}
  </aside>
}
