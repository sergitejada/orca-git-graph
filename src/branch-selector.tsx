import { useEffect, useId, useRef, useState } from 'react'

export function BranchSelector({ branches, value, onChange }: { branches: string[]; value: string; onChange(value: string): void }) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const activeOption = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const options = ['', ...branches.filter(name => name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))]
  const activeIndex = Math.min(active, options.length - 1)
  useEffect(() => { activeOption.current?.scrollIntoView({ block: 'nearest' }) }, [open, activeIndex, query])
  const label = (name: string) => name || 'Todas las ramas'
  const close = () => { setOpen(false); trigger.current?.focus() }
  const choose = (name: string) => { onChange(name); close() }
  const show = () => { setQuery(''); setActive(Math.max(0, ['', ...branches].indexOf(value))); setOpen(true) }

  return <div className="branch-selector" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
  }} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close() }
  }}>
    <span id={`${id}-label`} className="label">Ramas:</span>
    <div className="branch-control">
      <button ref={trigger} type="button" className="branch-trigger" aria-label="Filtrar por rama" aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-options`} title={label(value)} onClick={() => open ? setOpen(false) : show()} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show() }
      }}><span>{label(value)}</span><span aria-hidden="true">{open ? '▴' : '▾'}</span></button>
      {open ? <div className="branch-menu">
        <input autoFocus type="search" role="combobox" aria-label="Buscar ramas" aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-options`} aria-activedescendant={`${id}-option-${activeIndex}`} placeholder="Filtrar ramas…" value={query} onChange={event => { setQuery(event.target.value); setActive(0) }} onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setActive((activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length)
          } else if (event.key === 'Enter') { event.preventDefault(); choose(options[activeIndex]) }
        }} />
        <div id={`${id}-options`} role="listbox" aria-labelledby={`${id}-label`} className="branch-options">
          {options.map((name, index) => <div ref={index === activeIndex ? activeOption : null} key={name} id={`${id}-option-${index}`} role="option" aria-selected={name === value} className={`branch-option${index === activeIndex ? ' highlighted' : ''}`} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => choose(name)}>
            <span aria-hidden="true">{name === value ? '✓' : ''}</span><span>{label(name)}</span>
          </div>)}
        </div>
        {options.length === 1 && query.trim() ? <div className="branch-empty">No hay ramas que coincidan.</div> : null}
      </div> : null}
    </div>
  </div>
}
