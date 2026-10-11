import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import type { Change, PanelData, PanelRefs, PanelRow } from './types.js'
import { ROW, LANE, PAD, GREY, color } from './graph-style.js'
import { branchesOf, emptyFilters, findMatches } from './explore.js'
import { Details } from './details.js'

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

    const hollow = row.commit.wip || (row.commit.hash === head && wipLane < 0)
    const dotColor = row.commit.wip ? GREY : color(row.col)
    dots.push(<circle key={`d${index}`} cx={cx} cy={middle} r="4" opacity={matches.has(row.commit.hash) ? 1 : 0.3} fill={hollow ? 'var(--background, #171717)' : dotColor} stroke={hollow ? dotColor : undefined} strokeWidth={hollow ? 1.5 : undefined} />)
  })

  return <svg className="graph" width={width} height={rows.length * ROW} viewBox={`0 0 ${width} ${rows.length * ROW}`} fill="none" strokeWidth="2" strokeLinecap="round" aria-hidden="true">{paths}{dots}</svg>
}

function BranchIcon() {
  return <svg viewBox="0 0 10 16" aria-hidden="true"><path d="M10 5c0-1.11-.89-2-2-2a1.993 1.993 0 0 0-1 3.72v.3c-.02.52-.23.98-.63 1.38-.4.4-.86.61-1.38.63-.83.02-1.48.16-2 .45V4.72a1.993 1.993 0 0 0-1-3.72C.88 1 0 1.89 0 3a2 2 0 0 0 1 1.72v6.56c-.59.35-1 .99-1 1.72 0 1.11.89 2 2 2 1.11 0 2-.89 2-2 0-.53-.2-1-.53-1.36.09-.06.48-.41.59-.47.25-.11.56-.17.94-.17 1.05-.05 1.95-.45 2.75-1.25S8.95 7.77 9 6.73h-.02C9.59 6.37 10 5.73 10 5z" /></svg>
}

function TagIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 2.5v5.2l6.8 6.8 6.2-6.2-6.8-6.8H2.5a1 1 0 0 0-1 1Zm3 .8a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4Z" /></svg>
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
  onRowRef(element: HTMLTableRowElement | null): void
}

function CommitRow({ row, head, refs, graphRows, matches, selected, focusable, onSelect, onRowRef }: CommitRowProps) {
  const { commit } = row
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
    : `${commit.hash} · ${commit.author} · ${commit.dateLabel}\n\n${commit.subject}${commit.refs.length ? `\n\n${commit.refs.join(', ')}` : ''}`

  return <tr ref={onRowRef} data-hash={commit.hash} tabIndex={focusable ? 0 : -1} aria-selected={selected} aria-label={`${commit.wip ? 'Cambios sin confirmar' : commit.subject} · ${commit.hash}`} className={[commit.wip ? 'wip' : '', matches.has(commit.hash) ? '' : 'dimmed', selected ? 'selected' : ''].filter(Boolean).join(' ') || undefined} title={title} onClick={() => onSelect(commit.hash)} onKeyDown={event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(commit.hash) }
  }}>
    <td className="graph">{graphRows && <Graph rows={graphRows} head={head} matches={matches} />}</td>
    <td className="desc">{commit.wip ? <b>{`${commit.subject} (${commit.changes.length})`}</b> : <>
      {commit.hash === head && <span className="head-dot" style={{ borderColor: color(row.col) }} title="HEAD" />}
      <Refs refs={refs} />
      <span className="subject">{commit.subject}</span>
    </>}</td>
    <td className="date">{commit.wip ? <span className="clock">{commit.dateLabel}</span> : commit.dateLabel}</td>
    <td className="author">{commit.wip ? '*' : commit.author}</td>
    <td className="hash">{commit.wip ? '*' : commit.hash.slice(0, 8)}</td>
  </tr>
}

export function Panel({ repo, branch, head, rows, refsByCommit, now, error }: PanelData) {
  const [filters, setFilters] = useState(emptyFilters)
  const [showFilters, setShowFilters] = useState(false)
  const [selectedHash, setSelectedHash] = useState<string | null>(null)
  const [focusHash, setFocusHash] = useState(rows.some(row => row.commit.hash === head) ? head : rows[0]?.commit.hash || '')
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

  const selectHash = (hash: string) => {
    setSelectedHash(hash)
    setFocusHash(hash)
    const element = rowElements.current.get(hash)
    element?.focus({ preventScroll: true })
    element?.scrollIntoView({ block: 'nearest' })
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
      if (event.key === 'Escape') setSelectedHash(null)
      const target = event.target as HTMLElement | null
      if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !target?.closest('input, select, textarea, [contenteditable]')) {
        event.preventDefault()
        searchInput.current?.focus()
      }
    }
    document.addEventListener('keydown', shortcuts)
    return () => document.removeEventListener('keydown', shortcuts)
  }, [])
  const commits = rows.filter(row => !row.commit.wip).length
  return <>
    <header>
      <span><span className="label">Repo:</span> <b>{repo || '—'}</b></span>
      <span><span className="label">Rama:</span> <b>{branch || '—'}</b></span>
      <span className="sub">{`${commits} ${commits === 1 ? 'commit' : 'commits'}`}{now ? <> · actualizado <span className="clock">{now}</span></> : null}</span>
    </header>
    {error ? <div className="error">{error}</div> : null}
    {!error && !rows.length ? <div className="hint">Esperando a saber qué worktree mostrar: arranca un agente en Orca o ejecuta <b>Git Graph: Refrescar</b> desde la paleta de comandos.</div> : null}
    {rows.length ? <>
      <div className="toolbar" aria-label="Explorar historial">
        <input ref={searchInput} type="search" aria-label="Buscar commits" placeholder="Buscar mensaje, autor, hash… (/)" value={filters.query} onChange={event => setFilters({ ...filters, query: event.target.value })} />
        <button type="button" aria-expanded={showFilters} onClick={() => setShowFilters(!showFilters)}>Filtros{filterCount ? ` (${filterCount})` : ''}</button>
        <button type="button" disabled={!loadedHashes.has(head)} onClick={() => selectHash(head)}>Ir a HEAD</button>
        {filtered ? <button type="button" onClick={() => setFilters(emptyFilters)}>Limpiar</button> : null}
      </div>
      {showFilters ? <div className="filter-options">
        <label>Rama<select aria-label="Filtrar por rama" value={filters.branch} onChange={event => setFilters({ ...filters, branch: event.target.value })}><option value="">Todas las ramas</option>{branches.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
        <label>Autor<select aria-label="Filtrar por autor" value={filters.author} onChange={event => setFilters({ ...filters, author: event.target.value })}><option value="">Todos los autores</option>{authors.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
        <label className="merge-filter"><input type="checkbox" checked={filters.mergesOnly} onChange={event => setFilters({ ...filters, mergesOnly: event.target.checked })} />Solo merges</label>
      </div> : null}
      <div className="results-bar"><span role="status">{filtered ? `${matchingRows.length} coincidencias · contexto visible` : `${rows.length} filas`}</span><div><button type="button" aria-label="Coincidencia anterior" disabled={!matchingRows.length} onClick={() => navigate(-1)}>↑</button><button type="button" aria-label="Coincidencia siguiente" disabled={!matchingRows.length} onClick={() => navigate(1)}>↓</button></div></div>
      {filtered && !matchingRows.length ? <div className="hint no-matches">Sin coincidencias. Cambia la búsqueda o limpia los filtros.</div> : null}
      <div className={`workspace${selected ? ' details-open' : ''}`}>
      <div className="graph-list"><table onKeyDown={tableKeyDown} aria-label="Historial de commits">
      <thead><tr><th className="graph" style={{ minWidth: Math.max(28, 2 * PAD + (Math.max(1, ...rows.map(row => Math.max(row.before.length, row.after.length))) - 1) * LANE) }}>Grafo</th><th className="desc">Descripción</th><th className="date">Fecha</th><th className="author">Autor</th><th className="hash">Commit</th></tr></thead>
      <tbody>{rows.map((row, index) => <CommitRow key={row.commit.hash || index} row={row} head={head} refs={refsByCommit[row.commit.hash] || { heads: [], remotes: [], tags: [] }} graphRows={index === 0 ? rows : null} matches={matches} selected={selectedHash === row.commit.hash} focusable={focusHash === row.commit.hash} onSelect={selectHash} onRowRef={element => { if (element) rowElements.current.set(row.commit.hash, element); else rowElements.current.delete(row.commit.hash) }} />)}</tbody>
      </table></div>
      {selected ? <Details key={selected.commit.hash} row={selected} loadedHashes={loadedHashes} onClose={() => { setSelectedHash(null); rowElements.current.get(selected.commit.hash)?.focus({ preventScroll: true }) }} onJump={selectHash} /> : null}
      </div>
    </> : null}
  </>
}

