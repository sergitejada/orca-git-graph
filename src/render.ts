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
import { consumeHistoryRequest, readHistory, storedHistory, resetHistory, HISTORY_PAGE, HISTORY_MAX, type HistoryState } from './history.js'
import { PALETTE } from './graph-style.js'
import { layout, orderHistory } from './graph-layout.js'
import { loadCommitDiffs } from './commit-diff.js'

export { layout } from './graph-layout.js'
export { resetHistory } from './history.js'
import type { Change, GitCommit, GraphRow, GroupedRefs, LocalRef, PanelData, RenderOptions, UpstreamStatus, WorkingCommit } from './types.js'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
export const PANEL_PATH = join(HERE, 'panel.html')

const LOG_FORMAT = '%H%x1f%P%x1f%D%x1f%s%x1f%an%x1f%at%x1f%ae%x1f%B%x1e'
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
const two = (n: number) => String(n).padStart(2, '0')
export const formatDate = (d: Date): string =>
  `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`

type GitRunner = (repo: string, args: string[]) => Promise<string>

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: repo, maxBuffer: 16 * 1024 * 1024, timeout: 15000, windowsHide: true })
  return stdout
}
const runGit: GitRunner = git

const exitedWith = (error: unknown, code: number): boolean =>
  error instanceof Error && 'code' in error && error.code === code

async function readHead(repo: string, git: GitRunner = runGit): Promise<string> {
  try {
    return (await git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).trim()
  } catch (error) {
    if (!exitedWith(error, 1)) throw error
    // Unborn HEAD must point to a local branch whose ref does not yet exist.
    // An existing but broken ref, detached HEAD or other Git failure is an error.
    const ref = (await git(repo, ['symbolic-ref', 'HEAD'])).trim()
    if (!ref.startsWith('refs/heads/')) throw error
    try {
      await git(repo, ['show-ref', '--verify', '--quiet', ref])
    } catch (refError) {
      if (exitedWith(refError, 1)) return ''
      throw refError
    }
    throw error
  }
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
    return { ...commit, refs: [], stashParents: commit.parents, parents: commit.parents.slice(0, 1), stash: record.slice(0, separator) }
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

async function readUpstream(repo: string, branch: string, head: string, git: GitRunner = runGit): Promise<UpstreamStatus> {
  if (!branch) return { state: 'detached' }
  if (!head) return { state: 'unborn' }
  const refs = await git(repo, ['for-each-ref', '--format=%(refname)%09%(upstream)%09%(upstream:short)', 'refs/heads/'])
  const entry = refs.split('\n').find(line => line.split('\t')[0] === `refs/heads/${branch}`)
  const [, ref = '', name = ''] = (entry || '').trimEnd().split('\t')
  if (!ref) return { state: 'none' }
  const upstreamHead = await git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).catch(() => '')
  if (!upstreamHead) return { state: 'missing', name }
  try {
    const counts = await git(repo, ['rev-list', '--left-right', '--count', `${head}...${upstreamHead.trim()}`, '--'])
    const [ahead, behind] = counts.trim().split(/\s+/).map(Number)
    if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind) || ahead < 0 || behind < 0) throw new Error('Invalid counts')
    return { state: 'tracked', name, ahead, behind }
  } catch {
    return { state: 'unavailable', name }
  }
}

export function renderHtml({ repo, branch, head, upstream, rows, remotes = [], now = null, error, loading = false, unborn = false, history }: RenderOptions): string {
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
    upstream,
    rows: rows.map(row => {
      const { date, ...commit } = row.commit
      return { ...row, commit: { ...commit, dateLabel: commit.wip ? (now ? formatDate(now) : '') : (date ? formatDate(date) : '') } }
    }),
    refsByCommit,
    now: now ? now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '',
    error: error || '',
    loading,
    history,
    unborn,
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
interface BuilderDependencies {
  git: GitRunner
  layout: typeof layout
  loadCommitDiffs: typeof loadCommitDiffs
}

interface CachedHistory {
  repo: string
  key: string
  commits: GitCommit[]
  upstream: UpstreamStatus
  count: number
  incomplete: boolean
  notice?: string
  clean?: GraphRow[]
  working?: GraphRow[]
}

// Solo se conserva el repo actual. Se consulta Git en cada refresco: ninguna
// invalidación depende de watchers, mtimes del índice o ficheros de refs sueltas.
export function createPanelBuilder(dependencies: BuilderDependencies = { git, layout, loadCommitDiffs }): {
  build: (repo: string, historyState?: HistoryState, force?: boolean) => Promise<string>
  invalidate: () => void
} {
  let cache: CachedHistory | undefined
  let generation = 0
  const invalidate = () => { generation++; cache = undefined }
  const build = async (repo: string, historyState?: HistoryState, force = false): Promise<string> => {
    if (force || cache?.repo !== repo) invalidate()
    const currentGeneration = ++generation
    const now = new Date()
    try {
      // Valida el repo antes de nada; solo un repo bare omite status.
      const [bare = '', shallowPath = ''] = (await dependencies.git(repo, ['rev-parse', '--is-bare-repository', '--git-path', 'shallow']))
        .trim().split('\n').map(line => line.trim())
      const [stashLog, head, branch, refs, status, remotes] = await Promise.all([
        dependencies.git(repo, ['stash', 'list', '-n251', `--format=%gd%x1f${LOG_FORMAT}`]),
        readHead(repo, dependencies.git),
        dependencies.git(repo, ['branch', '--show-current']),
        // %(upstream) invalida también al cambiar la rama de seguimiento.
        dependencies.git(repo, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)%00%(upstream)', 'refs/heads', 'refs/remotes', 'refs/tags', 'refs/replace']),
        // status sin bloqueos evita chocar con el Git de un agente.
        bare === 'true' ? Promise.resolve('') : dependencies.git(repo, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all']),
        dependencies.git(repo, ['remote']),
      ])
      // Un fetch --deepen puede ampliar el historial sin mover ninguna ref.
      const shallow = shallowPath ? await readFile(resolve(repo, shallowPath), 'utf8').catch(error => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''
        throw error
      }) : ''
      const limit = historyState?.limit ?? HISTORY_PAGE
      const targets = [...new Set(historyState?.targets ?? [])]
      const key = JSON.stringify([head, branch, refs, stashLog, remotes, shallow, limit, targets])
      let history = cache?.repo === repo && cache.key === key ? cache : undefined
      if (!history) {
        const parsedStashes = parseStashes(stashLog)
        const stashes = parsedStashes.slice(0, HISTORY_PAGE)
        const bases = [...new Set(stashes.flatMap(stash => stash.parents))]
        const upstream = await readUpstream(repo, branch.trim(), head, dependencies.git)
        const log = await dependencies.git(repo, ['log', '--branches', '--remotes', '--tags', ...(head ? ['HEAD'] : []), ...bases, '--date-order', `-n${limit + 1}`, `--format=${LOG_FORMAT}`])
        const parsed = parseLog(log)
        const commits = parsed.slice(0, limit)
        const hashes = new Set(commits.map(commit => commit.hash))
        const missing = targets.filter(target => !hashes.has(target))
        if (missing.length) {
          const parents = parseLog(await dependencies.git(repo, ['log', '--no-walk=unsorted', '--ignore-missing', `--format=${LOG_FORMAT}`, ...missing]))
          for (const parent of parents) {
            if (!hashes.has(parent.hash)) { commits.push(parent); hashes.add(parent.hash) }
          }
        }
        const missingParent = missing.some(target => !hashes.has(target))
        const ordered = orderHistory(withStashes(commits, stashes))
        await dependencies.loadCommitDiffs(repo, ordered)
        history = {
          repo, key, commits: ordered, upstream, count: commits.length,
          incomplete: parsed.length > limit || commits.some(commit => commit.parents.some(parent => !hashes.has(parent))),
          notice: [
            missingParent ? 'Algún padre solicitado no está disponible en Git local. Puede tratarse de un clon superficial; descarga su historial para recorrerlo.' : '',
            parsedStashes.length > HISTORY_PAGE ? 'Solo se muestran los 250 stashes más recientes.' : '',
          ].filter(Boolean).join(' ') || undefined,
        }
      }
      const changes = parseStatus(status)
      let rows: GraphRow[]
      if (changes.length) {
        const working = wipCommit(changes, head)
        history.working ??= dependencies.layout([working, ...history.commits])
        rows = [{ ...history.working[0], commit: working }, ...history.working.slice(1)]
      } else {
        history.clean ??= dependencies.layout(history.commits)
        rows = history.clean
      }
      // Una lectura anterior no puede sustituir la caché de otro repo/refresco.
      if (currentGeneration === generation) cache = history
      return renderHtml({
        repo,
        branch: branch.trim() || '(HEAD detached)',
        head,
        upstream: history.upstream,
        rows,
        remotes: remotes.split('\n').map(r => r.trim()).filter(Boolean),
        now,
        history: {
          session: historyState?.session ?? '', limit, count: history.count, incomplete: history.incomplete,
          capped: limit >= HISTORY_MAX, focus: historyState?.focus, notice: history.notice,
        },
        unborn: !head,
      })
    } catch (e) {
      if (currentGeneration === generation) invalidate()
      return renderHtml({ repo, branch: '', head: '', rows: [], now, error: (e instanceof Error ? ('stderr' in e && typeof e.stderr === 'string' ? e.stderr : e.message) : String(e)).trim() })
    }
  }
  return { build, invalidate }
}

const panelBuilder = createPanelBuilder()
// Devuelve el HTML del repo; no escribe nada.
export const buildPanel = panelBuilder.build
export const invalidatePanelCache = panelBuilder.invalidate

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
export async function writePanel(repo: string, isCurrent?: () => Promise<boolean>, processHistoryRequest = false, force = false): Promise<boolean> {
  const guard = isCurrent ?? (async () => true)
  if (!await guard()) return false
  if (!isCurrent && (await storedHistory())?.repo !== repo) await resetHistory(repo)
  await hideGeneratedPanelFromGit()
  const state = await (processHistoryRequest ? consumeHistoryRequest(repo) : readHistory(repo))
  const html = await buildPanel(repo, state, force)
  const current = await readFile(PANEL_PATH, 'utf8').catch(() => '')
  if (panelFingerprint(current) === panelFingerprint(html)) return false
  if (!await guard()) return false
  const latest = await storedHistory()
  if (!latest || latest.session !== state.session || latest.limit !== state.limit || JSON.stringify(latest.targets) !== JSON.stringify(state.targets)) return false
  await writeFile(PANEL_PATH, html)
  return true
}

export async function resetPanel(): Promise<void> {
  invalidatePanelCache()
  await resetHistory()
  await hideGeneratedPanelFromGit()
  await writeFile(PANEL_PATH, renderHtml({ repo: '', branch: '', head: '', rows: [] }))
}

export async function writeLoadingPanel(repo = ''): Promise<void> {
  invalidatePanelCache()
  await hideGeneratedPanelFromGit()
  await writeFile(PANEL_PATH, renderHtml({ repo, branch: '', head: '', rows: [], loading: true }))
}

