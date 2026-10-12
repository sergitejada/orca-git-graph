import type { Change } from './types.js'

export type ChangesView = 'tree' | 'list'

interface ChangeStatus {
  kind: string
  label: string
}

function changeStatus({ x, y }: Change): ChangeStatus {
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return { kind: 'conflict', label: 'Conflicto' }
  if (x === '?' || y === '?') return { kind: 'untracked', label: 'Sin seguimiento' }
  if (x === 'D' || y === 'D') return { kind: 'deleted', label: 'Eliminado' }
  if (x === 'R' || y === 'R') return { kind: 'renamed', label: 'Renombrado' }
  if (x === 'A' || y === 'A') return { kind: 'added', label: 'Añadido' }
  if (x === 'C' || y === 'C') return { kind: 'added', label: 'Copiado' }
  if (x === 'T' || y === 'T') return { kind: 'modified', label: 'Tipo cambiado' }
  return { kind: 'modified', label: 'Modificado' }
}

function FileIcon({ folder = false }: { folder?: boolean }) {
  return <svg className="change-icon" viewBox="0 0 16 16" aria-hidden="true">
    {folder ? <path d="M1 3h5l2 2h7v2H1V3zm0 5h14l-2 6H3L1 8z" /> : <path d="M3 1h6v4h4v10H3V1zm7 0 3 3h-3V1z" />}
  </svg>
}

function ChangeFile({ change, name }: { change: Change; name: string }) {
  const status = changeStatus(change)
  return <div className="change-file" title={`${change.path} · ${status.label}`}>
    <FileIcon /><span className={`change-name change-${status.kind}`}>{name}</span><span className="change-accessible-status">{` · ${status.label} · ${change.path}`}</span>
  </div>
}

interface ChangeDirectory {
  directories: Map<string, ChangeDirectory>
  files: Change[]
}

function changeTree(changes: Change[]): ChangeDirectory {
  const root: ChangeDirectory = { directories: new Map(), files: [] }
  for (const change of changes) {
    const parts = change.path.split('/')
    let directory = root
    for (const part of parts.slice(0, -1)) {
      let child = directory.directories.get(part)
      if (!child) {
        child = { directories: new Map(), files: [] }
        directory.directories.set(part, child)
      }
      directory = child
    }
    directory.files.push(change)
  }
  return root
}

function DirectoryEntries({ directory }: { directory: ChangeDirectory }) {
  return <>
    {[...directory.directories].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => <li key={`directory-${name}`}>
      <details open className="change-directory"><summary><FileIcon folder /><span>{name}</span></summary><ul><DirectoryEntries directory={child} /></ul></details>
    </li>)}
    {[...directory.files].sort((a, b) => a.path.localeCompare(b.path)).map(change => <li key={`file-${change.path}`}><ChangeFile change={change} name={change.path.slice(change.path.lastIndexOf('/') + 1)} /></li>)}
  </>
}

export function ChangesViewButtons({ view, onChange }: { view: ChangesView; onChange(view: ChangesView): void }) {
  return <fieldset className="changes-view-buttons" aria-label="Vista de los cambios sin confirmar">
    <button className="icon-button" type="button" aria-label="Ver como árbol" title="Ver como árbol" aria-pressed={view === 'tree'} onClick={() => onChange('tree')}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2v9h3M2 5h3M8 2h6M8 5h6M8 8h6M8 11h6M8 14h6" /></svg></button>
    <button className="icon-button" type="button" aria-label="Ver como lista" title="Ver como lista" aria-pressed={view === 'list'} onClick={() => onChange('list')}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h1m3 0h8M2 8h1m3 0h8M2 13h1m3 0h8" /></svg></button>
  </fieldset>
}

export function Changes({ changes, view }: { changes: Change[]; view: ChangesView }) {
  return <ul className={`changes-list changes-${view}`} aria-label="Archivos sin confirmar">
    {view === 'tree' ? <DirectoryEntries directory={changeTree(changes)} /> : changes.map(change => <li key={change.path}><ChangeFile change={change} name={change.path} /></li>)}
  </ul>
}
