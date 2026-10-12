import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import type { Change, PanelData, PanelRefs, PanelRow } from './types.js'
import { ROW, LANE, PAD, GREY, color } from './graph-style.js'
import { branchesOf, emptyFilters, findMatches } from './explore.js'
import { Details } from './details.js'
import { BranchSelector } from './branch-selector.js'
import { StashMenu } from './stash-menu.js'
import { RepositoryActionDialog } from './repository-action-dialog.js'
import { defaultViewOptions, visibleHistory } from './view-options.js'
import { ViewOptionsMenu } from './view-options-menu.js'

const x = (lane: number) => PAD + lane * LANE
const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const middle = (y1 + y2) / 2
  return `M${x1} ${y1} C${x1} ${middle} ${x2} ${middle} ${x2} ${y2}`
}

function Graph({ rows, head, matches }: { rows: PanelRow[]; head: string; matches: Set<string> }) {
  const lanes = Math.max(1, ...rows.map(row => Math.max(row.before.length, row.after.length)))
  const width = PAD * 2 + (lanes - 1) * LANE
  const wipLane = rows[0]?.commit.wip ? rows[0].col : -1
  const stroke = (lane: number, hash: string | null) => lane === wipLane && hash === head ? GREY : color(lane)
  const paths: ReactElement[] = []
  const dots: ReactElement[] = []

  rows.forEach((row, index) => {
    const top = index * ROW
    const middle = top + ROW / 2
    const bottom = top + ROW
    const cx = x(row.col)
    const line = (d: string, c: string) => paths.push(<path key={`p${index}-${paths.length}`} d={d} stroke={c} />)

    for (let lane = 0; lane < Math.max(row.before.length, row.after.length); lane++) {
      if (lane === row.col || row.joins.includes(lane)) continue
      if (row.before[lane] && row.after[lane] === row.before[lane]) {
        line(`M${x(lane)} ${top} V${bottom}`, stroke(lane, row.before[lane]))
      }
    }
    if (row.hasIncoming) line(`M${cx} ${top} V${middle}`, stroke(row.col, row.commit.hash))
    for (const lane of row.joins) line(curve(x(lane), top, cx, middle), stroke(lane, row.commit.hash))
    if (row.after[row.col]) line(`M${cx} ${middle} V${bottom}`, row.commit.wip ? GREY : color(row.col))
    for (const lane of row.forks) {
      line(curve(cx, middle, x(lane), bottom), color(lane))
      if (row.before[lane] && row.before[lane] === row.after[lane]) {
        line(`M${x(lane)} ${top} V${bottom}`, color(lane))
      }
    }

    const hollow = row.commit.wip || Boolean(row.commit.stash) || (row.commit.hash === head && wipLane < 0)
    const dotColor = row.commit.wip ? GREY : color(row.col)
    dots.push(<circle key={`d${index}`} cx={cx} cy={middle} r="4" opacity={matches.has(row.commit.hash) ? 1 : 0.3} fill={hollow ? 'var(--panel-background)' : dotColor} stroke={hollow ? dotColor : undefined} strokeWidth={hollow ? 1.5 : undefined} />)
  })

  return <svg className="graph" width={width} height={rows.length * ROW} viewBox={`0 0 ${width} ${rows.length * ROW}`} fill="none" strokeWidth="2" strokeLinecap="round" aria-hidden="true">{paths}{dots}</svg>
}

function BranchIcon() {
  return <svg viewBox="0 0 10 16" aria-hidden="true"><path d="M10 5c0-1.11-.89-2-2-2a1.993 1.993 0 0 0-1 3.72v.3c-.02.52-.23.98-.63 1.38-.4.4-.86.61-1.38.63-.83.02-1.48.16-2 .45V4.72a1.993 1.993 0 0 0-1-3.72C.88 1 0 1.89 0 3a2 2 0 0 0 1 1.72v6.56c-.59.35-1 .99-1 1.72 0 1.11.89 2 2 2 1.11 0 2-.89 2-2 0-.53-.2-1-.53-1.36.09-.06.48-.41.59-.47.25-.11.56-.17.94-.17 1.05-.05 1.95-.45 2.75-1.25S8.95 7.77 9 6.73h-.02C9.59 6.37 10 5.73 10 5z" /></svg>
}

function TagIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 2.5v5.2l6.8 6.8 6.2-6.2-6.8-6.8H2.5a1 1 0 0 0-1 1Zm3 .8a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4Z" /></svg>
}

function StashIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2h12l2 9v3H0v-3L2 2Zm1.2 1.5L1.7 10H5l1 2h4l1-2h3.3l-1.5-6.5H3.2Z" /></svg>
}

function Refs({ refs }: { refs: PanelRefs }) {
  return <>{refs.heads.map(ref => <span className={`ref${ref.active ? ' active' : ''}`} key={`branch-${ref.name}`}><span className="ico" style={{ background: ref.color }}><BranchIcon /></span><span className="name">{ref.name}</span>{ref.remotes.map(remote => <span className="remote" key={remote}>{remote}</span>)}</span>)}
    {refs.remotes.map(ref => <span className="ref" key={`remote-${ref.name}`}><span className="ico" style={{ background: ref.color }}><BranchIcon /></span><span className="name">{ref.name}</span></span>)}
    {refs.tags.map(ref => <span className="ref" key={`tag-${ref.name}`}><span className="ico" style={{ background: ref.color }}><TagIcon /></span><span className="name">{ref.name}</span></span>)}</>
}

interface CommitRowProps {
  row: PanelRow
  head: string
  refs: PanelRefs
  graphRows: PanelRow[] | null
  matches: Set<string>
  selected: boolean
  focusable: boolean
  onSelect(hash: string): void
  onStashContextMenu(hash: string, name: string, left: number, top: number): void
  onRowRef(element: HTMLTableRowElement | null): void
}

function CommitRow({ row, head, refs, graphRows, matches, selected, focusable, onSelect, onStashContextMenu, onRowRef }: CommitRowProps) {
  const { commit } = row
  const stash = commit.stash
  const title = commit.wip
    ? (() => {
      const count = (predicate: (change: Change) => boolean, one: string, many: string) => {
        const total = commit.changes.filter(predicate).length
        return total ? `${total} ${total === 1 ? one : many}` : null
      }
      const summary = [
        count(change => change.x !== ' ' && change.x !== '?', 'preparado', 'preparados'),
        count(change => change.y !== ' ' && change.y !== '?', 'sin preparar', 'sin preparar'),
        count(change => change.x === '?', 'sin seguimiento', 'sin seguimiento'),
      ].filter(Boolean)
      const files = commit.changes.slice(0, 15).map(change => `${change.x}${change.y} ${change.path}`)
      if (commit.changes.length > 15) files.push(`… y ${commit.changes.length - 15} más`)
      return `${commit.subject}\n${summary.join(' · ')}\n\n${files.join('\n')}`
    })()
    : `${commit.stash ? `${commit.stash}\n` : ''}${commit.hash} · ${commit.author} · ${commit.dateLabel}\n\n${commit.subject}${commit.refs.length ? `\n\n${commit.refs.join(', ')}` : ''}`

  return <tr ref={onRowRef} data-hash={commit.hash} tabIndex={focusable ? 0 : -1} aria-selected={selected} aria-label={`${commit.wip ? 'Cambios sin confirmar' : commit.subject} · ${commit.hash}`} className={[commit.wip ? 'wip' : '', matches.has(commit.hash) ? '' : 'dimmed', selected ? 'selected' : ''].filter(Boolean).join(' ') || undefined} title={title} onClick={() => onSelect(commit.hash)} onKeyDown={event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(commit.hash) }
  }}>
    <td className="graph">{graphRows && <Graph rows={graphRows} head={head} matches={matches} />}</td>
    <td className="desc">{commit.wip ? <b>{`${commit.subject} (${commit.changes.length})`}</b> : <>
      {commit.hash === head && <span className="head-dot" style={{ borderColor: color(row.col) }} title="HEAD" />}
      <Refs refs={refs} />
      {stash ? <button type="button" className="ref stash" aria-label={`Acciones de ${stash}`} aria-haspopup="menu" onKeyDown={event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault()
          event.stopPropagation()
          const rect = event.currentTarget.getBoundingClientRect()
          onStashContextMenu(commit.hash, stash, rect.left, rect.bottom)
        }
      }} onContextMenu={event => {
        event.preventDefault()
        event.stopPropagation()
        onStashContextMenu(commit.hash, stash, event.clientX, event.clientY)
      }}><span className="ico" style={{ background: color(row.col) }}><StashIcon /></span><span className="name">{stash}</span></button> : null}
      <span className="subject">{commit.subject}</span>
    </>}</td>
    <td className="date">{commit.wip ? <span className="clock">{commit.dateLabel}</span> : commit.dateLabel}</td>
    <td className="author">{commit.wip ? '*' : commit.author}</td>
    <td className="hash">{commit.wip ? '*' : commit.hash.slice(0, 8)}</td>
  </tr>
}

export function Panel(data: PanelData) {
  if (data.loading) return <main className="loading-view" aria-busy="true">
    <div className="loading-status" role="status">
      <span className="loading-spinner" aria-hidden="true" />
      <h1>Cargando Git Graph…</h1>
      <p>{data.repo ? `Leyendo commits, ramas y cambios de ${data.repo}.` : 'Preparando el repositorio y su historial.'}</p>
    </div>
  </main>
  return <LoadedPanel {...data} />
}

function LoadedPanel({ repo, repoPath = '', actionModule = '', branch, head, rows: allRows, refsByCommit: allRefs, now, error, history }: PanelData) {
  const [viewOptions, setViewOptions] = useState(defaultViewOptions)
  const { rows, refsByCommit } = useMemo(() => visibleHistory(allRows, allRefs, head, viewOptions), [allRows, allRefs, head, viewOptions])
  const [repositoryAction, setRepositoryAction] = useState<'refresh' | 'fetch' | 'history' | null>(null)
  const [historyTarget, setHistoryTarget] = useState<string | undefined>()
  const actionButton = useRef<HTMLButtonElement | null>(null)
  const [showSearch, setShowSearch] = useState(false)
  const searchButton = useRef<HTMLButtonElement>(null)
  const [stashMenu, setStashMenu] = useState<{ hash: string; name: string; left: number; top: number } | null>(null)
  const [notice, setNotice] = useState('')
  const [filters, setFilters] = useState(emptyFilters)
  const [showFilters, setShowFilters] = useState(false)
  const [selectedHash, setSelectedHash] = useState<string | null>(history?.focus ?? null)
  const [detailsHeight, setDetailsHeight] = useState(40)
  const workspace = useRef<HTMLDivElement>(null)
  const resizeStart = useRef<{ y: number; height: number; available: number } | null>(null)
  const [focusHash, setFocusHash] = useState(history?.focus ?? (rows.some(row => row.commit.hash === head) ? head : rows[0]?.commit.hash || ''))
  const searchInput = useRef<HTMLInputElement>(null)
  const rowElements = useRef(new Map<string, HTMLTableRowElement>())
  const matches = useMemo(() => findMatches(rows, filters), [rows, filters])
  const matchingRows = rows.filter(row => matches.has(row.commit.hash))
  const selected = rows.find(row => row.commit.hash === selectedHash)
  const loadedHashes = useMemo(() => new Set(rows.map(row => row.commit.hash)), [rows])
  const branches = useMemo(() => branchesOf(rows), [rows])
  const authors = useMemo(() => [...new Set(rows.filter(row => !row.commit.wip).map(row => row.commit.author))].sort(), [rows])
  const filterCount = Number(Boolean(filters.branch)) + Number(Boolean(filters.author)) + Number(filters.mergesOnly)
  const filtered = Boolean(filters.query.trim() || filterCount)
  const resizeDetails = (height: number) => setDetailsHeight(Math.min(75, Math.max(20, height)))

  useEffect(() => { if (showSearch) searchInput.current?.focus() }, [showSearch])

  useEffect(() => {
    if (selectedHash) {
      const element = rowElements.current.get(selectedHash)
      element?.scrollIntoView({ block: 'nearest' })
      if (selectedHash === history?.focus) element?.focus({ preventScroll: true })
    }
  }, [selectedHash, history?.focus])

  const selectHash = (hash: string) => {
    setSelectedHash(hash)
    setFocusHash(hash)
    const element = rowElements.current.get(hash)
    element?.focus({ preventScroll: true })
    element?.scrollIntoView({ block: 'nearest' })
  }
  const loadHistory = (target?: string) => {
    if (document.activeElement instanceof HTMLButtonElement) actionButton.current = document.activeElement
    setHistoryTarget(target)
    setRepositoryAction('history')
  }
  const navigate = (direction: number, from = selectedHash || focusHash) => {
    if (!matchingRows.length) return
    const index = matchingRows.findIndex(row => row.commit.hash === from)
    const next = index < 0 ? (direction > 0 ? 0 : matchingRows.length - 1) : (index + direction + matchingRows.length) % matchingRows.length
    selectHash(matchingRows[next].commit.hash)
  }
  const tableKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const from = (event.target as HTMLElement).closest<HTMLTableRowElement>('tr')?.dataset.hash
    navigate(event.key === 'ArrowDown' ? 1 : -1, from)
  }
  useEffect(() => {
    const shortcuts = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelectedHash(null)
        if (selectedHash) rowElements.current.get(selectedHash)?.focus({ preventScroll: true })
      }
      const target = event.target as HTMLElement | null
      if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !target?.closest('input, select, textarea, [contenteditable]')) {
        event.preventDefault()
        setShowSearch(true)
        searchInput.current?.focus()
      }
    }
    document.addEventListener('keydown', shortcuts)
    return () => document.removeEventListener('keydown', shortcuts)
  }, [selectedHash])
  return <>
    <header>
      <span><span className="label">Repo:</span> <b>{repo || '—'}</b></span>
      <span><span className="label">Rama:</span> <b>{branch || '—'}</b></span>
      {now ? <span className="sub">actualizado <span className="clock">{now}</span></span> : null}
      <div className="header-actions">
        <button type="button" className="icon-button" aria-label="Fetch from remote" title="Fetch from remote" disabled={!repoPath || !actionModule} onClick={event => { actionButton.current = event.currentTarget; setRepositoryAction('fetch') }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17H5a4 4 0 0 1-.5-8A6 6 0 0 1 16 7a5 5 0 0 1 3 10h-2M12 11v10m-4-4 4 4 4-4" /></svg></button>
        <button type="button" className="icon-button" aria-label="Refrescar grafo" title="Refrescar grafo" disabled={!repoPath || !actionModule} onClick={event => { actionButton.current = event.currentTarget; setRepositoryAction('refresh') }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 8a8 8 0 1 1-5-4M15 1v4h4" /></svg></button>
        {allRows.length ? <>
          <button type="button" className="icon-button" aria-label="Ir a HEAD" title="Ir a HEAD" disabled={!loadedHashes.has(head)} onClick={() => selectHash(head)}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2" /><path d="M12 2v3m0 14v3M2 12h3m14 0h3" /></svg></button>
          <button ref={searchButton} type="button" className="icon-button" aria-label="Abrir búsqueda" title="Buscar commits (/)" aria-expanded={showSearch} aria-controls="commit-search" onClick={() => { setShowSearch(true); searchInput.current?.focus() }}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="7.5" /><path d="m16 16 6 6" /></svg></button>
          <ViewOptionsMenu value={viewOptions} onChange={next => {
            const nextRows = visibleHistory(allRows, allRefs, head, next).rows
            setViewOptions(next)
            if (filters.branch && !branchesOf(nextRows).includes(filters.branch)) setFilters({ ...filters, branch: '' })
            if (selectedHash && !nextRows.some(row => row.commit.hash === selectedHash)) setSelectedHash(null)
            if (!nextRows.some(row => row.commit.hash === focusHash)) setFocusHash(nextRows.some(row => row.commit.hash === head) ? head : nextRows[0]?.commit.hash || '')
            setStashMenu(null)
          }} />
          <button type="button" className="icon-button" aria-label="Filtros" title={filterCount ? `Filtros (${filterCount})` : 'Filtros'} aria-expanded={showFilters} aria-controls="history-filters" data-active={filterCount > 0 || undefined} onClick={() => setShowFilters(!showFilters)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h18l-7 8v7l-4 2v-9Z" /></svg>{filterCount ? <span className="filter-indicator" role="img" aria-label={`${filterCount} filtros activos`} /> : null}</button>
        </> : null}
      </div>
    </header>
    {error ? <div className="error">{error}</div> : null}
    {notice ? <p className="stash-notice" role="status">{notice}</p> : null}
    {!error && !allRows.length ? <div className="hint">Esperando a saber qué worktree mostrar: arranca un agente en Orca o ejecuta <b>Git Graph: Refrescar</b> desde la paleta de comandos.</div> : null}
    {allRows.length ? <>
      {history ? <div className="history-scope" role="status">
        <span>{history.count} commits cargados · {history.incomplete ? 'Historial incompleto' : 'Historial completo'}. Búsqueda y filtros solo en el historial cargado.</span>
        {history.incomplete ? <button type="button" disabled={history.capped || !history.session || !repoPath || !actionModule} onClick={event => { actionButton.current = event.currentTarget; loadHistory() }}>Cargar anteriores</button> : null}
        {history.capped ? <span>Límite de 5000 commits; puedes cargar padres individuales.</span> : null}
        {history.notice ? <span>{history.notice}</span> : null}
      </div> : null}
      <div className="branch-toolbar"><BranchSelector branches={branches} value={filters.branch} onChange={branch => setFilters({ ...filters, branch })} /></div>
      {filtered ? <fieldset className="toolbar" aria-label="Explorar historial"><button type="button" onClick={() => setFilters(emptyFilters)}>Limpiar</button></fieldset> : null}
      {showSearch ? <div className="search-toolbar" id="commit-search"><input ref={searchInput} type="search" aria-label="Buscar commits" placeholder="Buscar mensaje, autor, hash… (/)" value={filters.query} onChange={event => setFilters({ ...filters, query: event.target.value })} /><button type="button" aria-label="Cerrar búsqueda" title="Cerrar búsqueda" onClick={() => { setShowSearch(false); setFilters({ ...filters, query: '' }); searchButton.current?.focus() }}>×</button></div> : null}
      {showFilters ? <div className="filter-options" id="history-filters">
        <label>Autor<select aria-label="Filtrar por autor" value={filters.author} onChange={event => setFilters({ ...filters, author: event.target.value })}><option value="">Todos los autores</option>{authors.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
        <label className="merge-filter"><input type="checkbox" checked={filters.mergesOnly} onChange={event => setFilters({ ...filters, mergesOnly: event.target.checked })} />Solo merges</label>
      </div> : null}
      {filtered && !matchingRows.length ? <div className="hint no-matches">Sin coincidencias en el historial cargado. Cambia la búsqueda o limpia los filtros.</div> : null}
      <div ref={workspace} className={`workspace${selected ? ' details-open' : ''}`} style={selected ? { gridTemplateRows: `minmax(0, ${100 - detailsHeight}fr) 8px minmax(0, ${detailsHeight}fr)` } : undefined}>
      <div className="graph-list"><table onKeyDown={tableKeyDown} aria-label="Historial de commits">
      <thead><tr><th className="graph" style={{ minWidth: 12 + Math.max(28, 2 * PAD + (Math.max(1, ...rows.map(row => Math.max(row.before.length, row.after.length))) - 1) * LANE) }}>Grafo</th><th className="desc">Descripción</th><th className="date">Fecha</th><th className="author">Autor</th><th className="hash">Commit</th></tr></thead>
      <tbody>{rows.map((row, index) => <CommitRow key={row.commit.hash || index} row={row} head={head} refs={refsByCommit[row.commit.hash] || { heads: [], remotes: [], tags: [] }} graphRows={index === 0 ? rows : null} matches={matches} selected={selectedHash === row.commit.hash} focusable={focusHash === row.commit.hash} onSelect={hash => {
        selectHash(hash)
        setNotice('')
        setStashMenu(null)
      }} onStashContextMenu={(hash, name, left, top) => {
        setNotice('')
        setStashMenu({ hash, name, left, top })
      }} onRowRef={element => { if (element) rowElements.current.set(row.commit.hash, element); else rowElements.current.delete(row.commit.hash) }} />)}</tbody>
      </table></div>
      {selected ? <>
        {/* biome-ignore lint/a11y/useSemanticElements: interactive adjustable splitter, not a thematic break */}
        <div className="details-resizer" role="separator" tabIndex={0} aria-label="Ajustar altura de los detalles" aria-orientation="horizontal" aria-controls="commit-details" aria-valuemin={20} aria-valuemax={75} aria-valuenow={Math.round(detailsHeight)} aria-valuetext={`${Math.round(detailsHeight)}% del panel`} onPointerDown={event => {
          if (event.button !== 0 || !workspace.current) return
          event.preventDefault()
          event.currentTarget.focus()
          event.currentTarget.setPointerCapture(event.pointerId)
          resizeStart.current = { y: event.clientY, height: detailsHeight, available: Math.max(1, workspace.current.clientHeight - 8) }
        }} onPointerMove={event => {
          const start = resizeStart.current
          if (start) resizeDetails(start.height + (start.y - event.clientY) / start.available * 100)
        }} onPointerUp={event => {
          resizeStart.current = null
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        }} onPointerCancel={() => { resizeStart.current = null }} onLostPointerCapture={() => { resizeStart.current = null }} onKeyDown={event => {
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          resizeDetails(event.key === 'Home' ? 20 : event.key === 'End' ? 75 : detailsHeight + (event.key === 'ArrowUp' ? 5 : -5))
        }} />
        <Details key={selected.commit.hash} row={selected} loadedHashes={loadedHashes} onClose={() => { setSelectedHash(null); rowElements.current.get(selected.commit.hash)?.focus({ preventScroll: true }) }} onJump={selectHash} onLoadParent={history?.session ? loadHistory : undefined} />
      </> : null}
      </div>
    </> : null}
    {stashMenu ? <StashMenu key={stashMenu.hash} {...stashMenu} repo={repoPath} onNotice={setNotice} onClose={() => { setStashMenu(null); rowElements.current.get(stashMenu.hash)?.focus({ preventScroll: true }) }} /> : null}
    {repositoryAction ? <RepositoryActionDialog action={repositoryAction} history={history ? { session: history.session, limit: history.limit, target: historyTarget } : undefined} repo={repoPath} module={actionModule} onNotice={setNotice} onClose={() => { setRepositoryAction(null); actionButton.current?.focus() }} /> : null}
  </>
}

