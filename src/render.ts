// Lee Git, prepara los datos y genera panel.html con el renderizado React.
// Lo usa el worker (main.mjs) y también se puede lanzar a mano:
//   node render.mjs <ruta-del-repo>
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { Panel } from './panel.js'
import { script, styles } from 'panel-assets'
import { PALETTE } from './graph-style.js'
import type { Change, Commit, GitCommit, GraphRow, GroupedRefs, LocalRef, PanelData, RenderOptions, WorkingCommit } from './types.js'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
export const PANEL_PATH = join(HERE, 'panel.html')

const LIMIT = 250
const LOG_FORMAT = '%H%x1f%P%x1f%D%x1f%s%x1f%an%x1f%at%x1f%ae%x1f%B%x1e'
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
const two = (n: number) => String(n).padStart(2, '0')
export const formatDate = (d: Date): string =>
  `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: repo, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  return stdout
}

async function hideGeneratedPanelFromGit() {
  try {
    await git(HERE, ['update-index', '--skip-worktree', '--', 'panel.html'])
  } catch {
    // The plugin can still render when its directory is not a Git checkout.
  }
}

export function parseLog(stdout: string): GitCommit[] {
  return stdout
    .split('\x1e')
    .map(record => record.replace(/^\s+/, ''))
    .filter(Boolean)
    .map(record => {
      const [hash = '', parents = '', refs = '', subject = '', author = '', time = '', authorEmail = '', message = subject] = record.split('\x1f')
      return {
        hash,
        parents: parents.split(' ').filter(Boolean),
        refs: refs.split(', ').map(r => r.trim()).filter(Boolean),
        subject,
        author,
        date: time ? new Date(Number(time) * 1000) : null,
        authorEmail,
        message: message.trimEnd(),
      }
    })
}

// El reflog enumera todos los stashes, no solo la punta de refs/stash.
// Sus otros padres son snapshots internos del índice y de ficheros sin seguimiento.
export function parseStashes(stdout: string): GitCommit[] {
  return stdout.split('\x1e').map(record => record.trimStart()).filter(Boolean).map(record => {
    const separator = record.indexOf('\x1f')
    const [commit] = parseLog(record.slice(separator + 1))
    return { ...commit, refs: [], parents: commit.parents.slice(0, 1), stash: record.slice(0, separator) }
  })
}

export function withStashes(commits: GitCommit[], stashes: GitCommit[]): GitCommit[] {
  const stashHashes = new Set(stashes.map(stash => stash.hash))
  const result = commits.filter(commit => !stashHashes.has(commit.hash))
  for (const stash of [...stashes].reverse()) {
    const index = result.findIndex(commit => commit.hash === stash.parents[0]
      || (commit.date && stash.date && commit.date <= stash.date))
    result.splice(index < 0 ? result.length : index, 0, stash)
  }
  return result
}

// Salida de `git status --porcelain=v1 -z`: "XY ruta\0". En renombrados y
// copias la ruta original llega como entrada aparte y se descarta.
export function parseStatus(stdout: string): Change[] {
  const entries = stdout.split('\0')
  const changes: Change[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.length < 4) continue
    const [x, y] = entry
    changes.push({ x, y, path: entry.slice(3) })
    if (x === 'R' || x === 'C') i++
  }
  return changes
}

// Commit ficticio que cuelga de HEAD y representa el árbol de trabajo
export const WIP = 'WORKING_TREE'
export const wipCommit = (changes: Change[], head: string): WorkingCommit => ({
  hash: WIP,
  wip: true,
  changes,
  parents: head ? [head] : [],
  refs: [],
  subject: 'Cambios sin confirmar',
  author: '',
  date: null,
})

// Cada carril espera un hash. Un commit ocupa el carril que lo espera; los
// demás que lo esperaban confluyen en él (joins) y cada padre extra abre o
// reutiliza un carril (forks). Los carriles no se desplazan: las verticales
// son rectas y solo confluencias y ramas llevan curva.
export function layout(commits: Commit[]): GraphRow[] {
  const lanes: (string | null)[] = []
  const rows: GraphRow[] = []
  const freeSlot = () => {
    const i = lanes.indexOf(null)
    if (i >= 0) return i
    lanes.push(null)
    return lanes.length - 1
  }
  for (const commit of commits) {
    let col = lanes.indexOf(commit.hash)
    const hasIncoming = col >= 0
    if (col < 0) col = freeSlot()
    const before = lanes.slice()
    const joins: number[] = []
    lanes.forEach((h, i) => {
      if (i !== col && h === commit.hash) {
        joins.push(i)
        lanes[i] = null
      }
    })
    const [first, ...rest] = commit.parents
    lanes[col] = first ?? null
    const forks: number[] = []
    for (const parent of rest) {
      const existing = lanes.indexOf(parent)
      if (existing >= 0) forks.push(existing)
      else {
        const slot = freeSlot()
        lanes[slot] = parent
        forks.push(slot)
      }
    }
    const after = lanes.slice()
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()
    rows.push({ commit, col, hasIncoming, before, after, joins, forks })
  }
  return rows
}

// Agrupa las refs de `git log %D` en ramas, remotas sueltas y tags.
export function groupRefs(refs: string[], remotes: string[] = []): GroupedRefs {
  const byLength = [...remotes].sort((a, b) => b.length - a.length)
  const remoteOf = (ref: string) => byLength.find(remote => ref.startsWith(`${remote}/`))
  const heads: LocalRef[] = []
  const remoteRefs: string[] = []
  const tags: string[] = []
  for (const ref of refs) {
    if (ref.startsWith('HEAD -> ')) heads.push({ name: ref.slice(8), active: true, remotes: [] })
    else if (ref === 'HEAD') heads.push({ name: 'HEAD', active: true, remotes: [] })
    else if (ref.startsWith('tag: ')) tags.push(ref.slice(5))
    else if (remoteOf(ref)) remoteRefs.push(ref)
    else heads.push({ name: ref, active: false, remotes: [] })
  }
  const loose = remoteRefs.filter(ref => {
    const remote = remoteOf(ref)
    if (!remote) return true
    const local = heads.find(head => head.name === ref.slice(remote.length + 1))
    if (!local) return true
    local.remotes.push(remote)
    return false
  })
  return { heads, remotes: loose, tags }
}

export function renderHtml({ repo, branch, head, rows, remotes = [], now = null, error, loading = false }: RenderOptions): string {
  const refsByCommit = Object.fromEntries(rows.map(row => {
    const laneColor = PALETTE[row.col % PALETTE.length]
    const refs = groupRefs(row.commit.refs, remotes)
    return [row.commit.hash, {
      heads: refs.heads.map(ref => ({ ...ref, color: laneColor })),
      remotes: refs.remotes.map(name => ({ name, color: laneColor })),
      tags: refs.tags.map(name => ({ name, color: laneColor })),
    }]
  }))
  const payload: PanelData = {
    repo: repo ? basename(resolve(repo)) : '',
    repoPath: repo ? resolve(repo) : '',
    actionModule: new URL('./render.mjs', import.meta.url).href,
    branch: branch || '',
    head,
    rows: rows.map(row => {
      const { date, ...commit } = row.commit
      return { ...row, commit: { ...commit, dateLabel: commit.wip ? (now ? formatDate(now) : '') : (date ? formatDate(date) : '') } }
    }),
    refsByCommit,
    now: now ? now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '',
    error: error || '',
    loading,
  }
  const app = renderToString(React.createElement(Panel, payload))
  const serialized = JSON.stringify(payload)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>${styles}</style>
</head>
<body>
<div id="root">${app}</div>
<script type="application/json" id="git-graph-data">${serialized}</script>
<script>${script}</script>
</body>
</html>`
}
// Devuelve el HTML del repo; no escribe nada.
export async function buildPanel(repo: string): Promise<string> {
  const now = new Date()
  try {
    const [stashLog, head, branch, status, remotes] = await Promise.all([
      git(repo, ['stash', 'list', `--format=%gd%x1f${LOG_FORMAT}`]),
      git(repo, ['rev-parse', 'HEAD']),
      git(repo, ['branch', '--show-current']),
      // sin --no-optional-locks, status refresca el índice y puede chocar
      // con el git de un agente; en un repo bare falla y se ignora
      git(repo, ['--no-optional-locks', 'status', '--porcelain=v1', '-z']).catch(() => ''),
      git(repo, ['remote']).catch(() => ''),
    ])
    const stashes = parseStashes(stashLog)
    const bases = [...new Set(stashes.flatMap(stash => stash.parents))]
    const log = await git(repo, ['log', '--branches', '--remotes', '--tags', 'HEAD', ...bases, '--date-order', `-n${LIMIT}`, `--format=${LOG_FORMAT}`])
    const commits: Commit[] = withStashes(parseLog(log), stashes)
    const changes = parseStatus(status)
    if (changes.length) commits.unshift(wipCommit(changes, head.trim()))
    return renderHtml({
      repo,
      branch: branch.trim() || '(HEAD detached)',
      head: head.trim(),
      rows: layout(commits),
      remotes: remotes.split('\n').map(r => r.trim()).filter(Boolean),
      now,
    })
  } catch (e) {
    return renderHtml({ repo, branch: '', head: '', rows: [], now, error: (e instanceof Error ? ('stderr' in e && typeof e.stderr === 'string' ? e.stderr : e.message) : String(e)).trim() })
  }
}

// Escribe panel.html solo si el grafo cambió (las horas no cuentan),
// para que Orca no recargue el panel sin motivo.
export function panelFingerprint(html: string): string {
  return html.replace(/<span class="clock">[^<]*<\/span>/g, '')
    .replace(/(<script type="application\/json" id="git-graph-data">)([\s\S]*?)(<\/script>)/, (_match: string, open: string, json: string, close: string) => {
      const payload = JSON.parse(json) as PanelData
      payload.now = ''
      payload.rows.forEach(row => { if (row.commit.wip) row.commit.dateLabel = '' })
      return open + JSON.stringify(payload) + close
    })
}
export async function writePanel(repo: string, isCurrent: () => Promise<boolean> = async () => true): Promise<boolean> {
  await hideGeneratedPanelFromGit()
  const html = await buildPanel(repo)
  const current = await readFile(PANEL_PATH, 'utf8').catch(() => '')
  if (panelFingerprint(current) === panelFingerprint(html)) return false
  if (!await isCurrent()) return false
  await writeFile(PANEL_PATH, html)
  return true
}

export async function resetPanel(): Promise<void> {
  await hideGeneratedPanelFromGit()
  await writeFile(PANEL_PATH, renderHtml({ repo: '', branch: '', head: '', rows: [] }))
}

export async function writeLoadingPanel(repo = ''): Promise<void> {
  await hideGeneratedPanelFromGit()
  await writeFile(PANEL_PATH, renderHtml({ repo, branch: '', head: '', rows: [], loading: true }))
}

