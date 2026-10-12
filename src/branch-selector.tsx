import { useCallback, useId, useRef, useState } from 'react'

export function BranchSelector({ branches, value, onChange }: { branches: string[]; value: string; onChange(value: string): void }) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const focusSearch = useCallback((element: HTMLInputElement | null) => { element?.focus() }, [])
  const scrollActiveOption = useCallback((element: HTMLDivElement | null) => { element?.scrollIntoView({ block: 'nearest' }) }, [])
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const options = ['', ...branches.filter(name => name.toLocaleLowerCase().includes(normalizedQuery))]
  const activeIndex = Math.min(active, options.length - 1)
  const label = (name: string) => name || 'Todas las ramas'
  const close = () => { setOpen(false); trigger.current?.focus() }
  const choose = (name: string) => { onChange(name); close() }
  const show = () => { setQuery(''); setActive(Math.max(0, ['', ...branches].indexOf(value))); setOpen(true) }

  return <fieldset className="branch-selector" aria-labelledby={`${id}-label`} onBlur={event => {
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
        <input ref={focusSearch} type="search" role="combobox" aria-label="Buscar ramas" aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-options`} aria-activedescendant={`${id}-option-${activeIndex}`} placeholder="Filtrar ramas…" value={query} onChange={event => { setQuery(event.target.value); setActive(0) }} onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setActive((activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length)
          } else if (event.key === 'Enter') { event.preventDefault(); choose(options[activeIndex]) }
        }} />
        <div id={`${id}-options`} role="listbox" aria-labelledby={`${id}-label`} className="branch-options">
          {/* El combobox mantiene el foco y navega las opciones mediante aria-activedescendant. */}
          {options.map((name, index) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/useFocusableInteractive: El teclado se gestiona en el combobox; las opciones no reciben foco DOM.
            <div ref={index === activeIndex ? scrollActiveOption : null} key={name} id={`${id}-option-${index}`} role="option" aria-selected={name === value} className={`branch-option${index === activeIndex ? ' highlighted' : ''}`} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => choose(name)}>
            <span aria-hidden="true">{name === value ? '✓' : ''}</span><span>{label(name)}</span>
          </div>))}
        </div>
        {options.length === 1 && query.trim() ? <div className="branch-empty">No hay ramas que coincidan.</div> : null}
      </div> : null}
    </div>
  </fieldset>
}
