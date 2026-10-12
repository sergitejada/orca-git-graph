import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ViewOptions } from './view-options.js'

export function ViewOptionsMenu({ value, onChange }: { value: ViewOptions; onChange(value: ViewOptions): void }) {
  const [open, setOpen] = useState(false)
  const control = useRef<HTMLFieldSetElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const close = () => { setOpen(false); trigger.current?.focus() }
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return
    const button = trigger.current.getBoundingClientRect()
    const popup = menu.current.getBoundingClientRect()
    setPosition({ left: Math.max(10, Math.min(button.right - popup.width, window.innerWidth - popup.width - 10)), top: Math.max(4, Math.min(button.bottom + 4, window.innerHeight - popup.height - 4)) })
  }, [open])
  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const outside = (event: PointerEvent) => { if (!control.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])

  return <fieldset ref={control} className="view-options-control" aria-label="Opciones de visualización" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
  }} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close() }
  }}>
    <button ref={trigger} type="button" className="icon-button" aria-label="Opciones del grafo" title="Opciones del grafo" aria-haspopup="menu" aria-expanded={open} aria-controls="graph-view-options" onClick={() => setOpen(!open)} onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) }
    }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="8" cy="6" r="2" /><circle cx="16" cy="12" r="2" /><circle cx="10" cy="18" r="2" /></svg></button>
    {open ? <div ref={menu} id="graph-view-options" className="view-options-menu" style={position} role="menu" aria-label="Opciones del grafo" onKeyDown={event => {
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
      const index = items.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1
      if (next >= 0) { event.preventDefault(); items[next].focus() }
    }}>
      <button type="button" role="menuitemcheckbox" aria-checked={value.remoteBranches} onClick={() => onChange({ ...value, remoteBranches: !value.remoteBranches })}><span aria-hidden="true">{value.remoteBranches ? '✓' : ''}</span>Mostrar ramas remotas</button>
      <button type="button" role="menuitemcheckbox" aria-checked={value.stashes} onClick={() => onChange({ ...value, stashes: !value.stashes })}><span aria-hidden="true">{value.stashes ? '✓' : ''}</span>Mostrar stashes</button>
    </div> : null}
  </fieldset>
}
