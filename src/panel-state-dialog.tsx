import { useEffect, useRef, useState } from 'react'
import { copyText } from './host.js'
import { MAX_PANEL_STATE_LENGTH } from './panel-state.js'

interface PanelStateDialogProps {
  snapshot: string
  onRestore(text: string): void
  onClose(): void
}

export function PanelStateDialog({ snapshot, onRestore, onClose }: PanelStateDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState(snapshot)
  const [message, setMessage] = useState('')
  const [selectForCopy, setSelectForCopy] = useState(false)
  useEffect(() => { dialog.current?.showModal(); input.current?.focus(); input.current?.select() }, [])
  useEffect(() => {
    if (!selectForCopy) return
    input.current?.focus()
    input.current?.select()
    setSelectForCopy(false)
  }, [selectForCopy])
  return <dialog ref={dialog} className="stash-dialog panel-state-dialog" aria-labelledby="panel-state-title" onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose() }}>
    <h2 id="panel-state-title">Estado del panel</h2>
    <p>Orca todavía no permite guardar automáticamente el estado del iframe. Copia esta instantánea antes de una actualización y pégala aquí después para restaurarla en este worktree.</p>
    <p className="stash-repo">Incluye la ruta local del worktree y el texto de búsqueda. Guárdala en un lugar privado.</p>
    <label>Instantánea del panel<textarea ref={input} value={text} maxLength={MAX_PANEL_STATE_LENGTH} onChange={event => { setText(event.target.value); setMessage('') }} spellCheck={false} /></label>
    <p role="status">{message}</p>
    <div className="stash-dialog-buttons">
      <button type="button" onClick={() => {
        void copyText(snapshot).then(() => setMessage('Instantánea actual copiada.')).catch(() => {
          setText(snapshot)
          setSelectForCopy(true)
          setMessage('Pulsa Ctrl+C para copiar la instantánea actual.')
        })
      }}>Copiar actual</button>
      <button type="button" onClick={() => {
        try { onRestore(text) } catch (error) { setMessage(error instanceof Error ? error.message : 'No se pudo restaurar la instantánea.') }
      }}>Restaurar</button>
      <button type="button" onClick={onClose}>Cerrar</button>
    </div>
  </dialog>
}
