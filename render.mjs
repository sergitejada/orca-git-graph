// Genera panel.html (grafo de commits en SVG) para el panel de Orca.
// Lo usa el worker (main.mjs) y también se puede lanzar a mano:
//   node render.mjs <ruta-del-repo>
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
export const PANEL_PATH = join(HERE, 'panel.html')

const LIMIT = 250
const ROW = 24
const LANE = 14
const PAD = 10
const LOG_FORMAT = '%H%x1f%P%x1f%D%x1f%s%x1f%an%x1f%ar%x1f%ad%x1e'
const PALETTE = ['#4FC3F7', '#F06292', '#81C784', '#FFB74D', '#BA68C8', '#4DB6AC', '#E57373', '#DCE775']
const color = lane => PALETTE[lane % PALETTE.length]

const esc = text =>
  String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])

async function git(repo, args) {
  const { stdout } = await run('git', args, { cwd: repo, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  return stdout
}

function parseLog(stdout) {
  return stdout
    .split('\x1e')
    .map(record => record.replace(/^\s+/, ''))
    .filter(Boolean)
    .map(record => {
      const [hash = '', parents = '', refs = '', subject = '', author = '', ago = '', date = ''] = record.split('\x1f')
      return {
        hash,
        parents: parents.split(' ').filter(Boolean),
        refs: refs.split(', ').map(r => r.trim()).filter(Boolean),
        subject,
        author,
        ago,
        date,
      }
    })
}

// Salida de `git status --porcelain=v1 -z`: "XY ruta\0". En renombrados y
// copias la ruta original llega como entrada aparte y se descarta.
export function parseStatus(stdout) {
  const entries = stdout.split('\0')
  const changes = []
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
export const wipCommit = (changes, head) => ({
  hash: WIP,
  wip: true,
  changes,
  parents: head ? [head] : [],
  refs: [],
  subject: 'Cambios sin confirmar',
  author: '',
  ago: '',
  date: '',
})

// Cada carril espera un hash. Un commit ocupa el carril que lo espera; los
// demás que lo esperaban confluyen en él (joins) y cada padre extra abre o
// reutiliza un carril (forks). Los carriles no se desplazan: las verticales
// son rectas y solo confluencias y ramas llevan curva.
export function layout(commits) {
  const lanes = []
  const rows = []
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
    const joins = []
    lanes.forEach((h, i) => {
      if (i !== col && h === commit.hash) {
        joins.push(i)
        lanes[i] = null
      }
    })
    const [first, ...rest] = commit.parents
    lanes[col] = first ?? null
    const forks = []
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

const x = lane => PAD + lane * LANE
const curve = (x1, y1, x2, y2) => {
  const my = (y1 + y2) / 2
  return `M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}`
}

function graphSvg(rows, head) {
  const lanes = Math.max(1, ...rows.map(r => Math.max(r.before.length, r.after.length)))
  const width = PAD * 2 + (lanes - 1) * LANE
  const paths = []
  const dots = []
  // el carril que une los cambios sin confirmar con HEAD va discontinuo
  const wipLane = rows[0]?.commit.wip ? rows[0].col : -1
  const dashed = (lane, hash) => lane === wipLane && hash === head
  rows.forEach((row, r) => {
    const top = r * ROW
    const mid = top + ROW / 2
    const bottom = top + ROW
    const cx = x(row.col)
    const line = (d, lane, dash = false) =>
      paths.push(`<path d="${d}" stroke="${color(lane)}"${dash ? ' stroke-dasharray="3 3"' : ''}/>`)
    // carriles que solo pasan por esta fila
    const width = Math.max(row.before.length, row.after.length)
    for (let i = 0; i < width; i++) {
      if (i === row.col || row.joins.includes(i)) continue
      if (row.before[i] && row.after[i] === row.before[i]) line(`M${x(i)} ${top} V${bottom}`, i, dashed(i, row.before[i]))
    }
    if (row.hasIncoming) line(`M${cx} ${top} V${mid}`, row.col, dashed(row.col, row.commit.hash))
    for (const j of row.joins) line(curve(x(j), top, cx, mid), j, dashed(j, row.commit.hash))
    if (row.after[row.col]) line(`M${cx} ${mid} V${bottom}`, row.col, row.commit.wip)
    for (const f of row.forks) {
      line(curve(cx, mid, x(f), bottom), f)
      // un carril que ya existía sigue su vertical bajo la curva
      if (row.before[f] && row.before[f] === row.after[f]) line(`M${x(f)} ${top} V${bottom}`, f)
    }
    const isHead = row.commit.hash === head
    const isMerge = row.commit.parents.length > 1
    dots.push(
      row.commit.wip
        ? `<circle cx="${cx}" cy="${mid}" r="4.5" fill="var(--background, #1e1e1e)" stroke="${color(row.col)}" stroke-width="2" stroke-dasharray="2.5 2"/>`
        : isHead
        ? `<circle cx="${cx}" cy="${mid}" r="5.5" fill="var(--background, #1e1e1e)" stroke="${color(row.col)}" stroke-width="2.5"/>`
        : `<circle cx="${cx}" cy="${mid}" r="${isMerge ? 3 : 4}" fill="${color(row.col)}"/>`,
    )
  })
  return `<svg class="graph" width="${width}" height="${rows.length * ROW}" viewBox="0 0 ${width} ${rows.length * ROW}" fill="none" stroke-width="2" stroke-linecap="round">${paths.join('')}${dots.join('')}</svg>`
}

function refPill(ref) {
  let kind = 'branch'
  let label = ref
  if (ref.startsWith('HEAD -> ')) {
    kind = 'head'
    label = ref.slice(8)
  } else if (ref === 'HEAD') kind = 'head'
  else if (ref.startsWith('tag: ')) {
    kind = 'tag'
    label = ref.slice(5)
  } else if (ref.includes('/')) kind = 'remote'
  return `<span class="ref ${kind}">${esc(label)}</span>`
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
const MAX_TIP_FILES = 15

function wipRow(c) {
  const count = (pred, one, many) => {
    const n = c.changes.filter(pred).length
    return n ? plural(n, one, many) : null
  }
  const summary = [
    count(ch => ch.x !== ' ' && ch.x !== '?', 'preparado', 'preparados'),
    count(ch => ch.y !== ' ' && ch.y !== '?', 'sin preparar', 'sin preparar'),
    count(ch => ch.x === '?', 'sin seguimiento', 'sin seguimiento'),
  ].filter(Boolean)
  const files = c.changes.slice(0, MAX_TIP_FILES).map(ch => `${ch.x}${ch.y} ${ch.path}`)
  if (c.changes.length > MAX_TIP_FILES) files.push(`… y ${c.changes.length - MAX_TIP_FILES} más`)
  const tip = `${c.subject}\n${summary.join(' · ')}\n\n${files.join('\n')}`
  return `<div class="row wip" title="${esc(tip)}"><span class="subject">${esc(c.subject)}</span><span class="meta">${plural(c.changes.length, 'fichero', 'ficheros')}</span></div>`
}

export function renderHtml({ repo, branch, head, rows, error }) {
  const now = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const commitCount = rows.filter(row => !row.commit.wip).length
  const list = rows
    .map(row => {
      const c = row.commit
      if (c.wip) return wipRow(c)
      const tip = `${c.hash.slice(0, 10)} · ${c.author} · ${c.date}\n\n${c.subject}${c.refs.length ? `\n\n${c.refs.join(', ')}` : ''}`
      return `<div class="row${c.hash === head ? ' is-head' : ''}" title="${esc(tip)}">${c.refs.slice(0, 2).map(refPill).join('')}${c.refs.length > 2 ? `<span class="more">+${c.refs.length - 2}</span>` : ''}<span class="subject">${esc(c.subject)}</span><span class="meta">${esc(c.ago.replace(/ ago$/, ''))}</span></div>`
    })
    .join('')
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    font-size: 12px;
    color: var(--foreground, #ddd);
    background: var(--background, transparent);
  }
  header {
    position: sticky; top: 0; z-index: 1;
    padding: 8px 10px;
    background: var(--background, #1e1e1e);
    border-bottom: 1px solid var(--border, #333);
  }
  .branch { font-weight: 600; font-size: 13px; }
  .sub { color: var(--muted-foreground, #999); margin-top: 2px; font-size: 11px; }
  .error { color: #E57373; padding: 10px; white-space: pre-wrap; }
  .hint { color: var(--muted-foreground, #999); padding: 10px; line-height: 1.5; }
  .body { display: flex; align-items: flex-start; padding-top: 4px; }
  .graph { flex: none; display: block; }
  .list { flex: 1; min-width: 0; }
  .row {
    height: ${ROW}px; display: flex; align-items: center; gap: 6px;
    padding-right: 10px; white-space: nowrap; overflow: hidden;
    border-radius: 4px;
  }
  .row:hover { background: var(--accent, rgba(127,127,127,.15)); }
  .row.is-head .subject { font-weight: 600; }
  .row.wip .subject { font-style: italic; color: var(--muted-foreground, #999); }
  .more { flex: none; color: var(--muted-foreground, #999); font-size: 10.5px; }
  .ref {
    flex: 0 1 auto; min-width: 28px; max-width: 30%; overflow: hidden; text-overflow: ellipsis;
    padding: 0 6px; line-height: 16px; border-radius: 8px; font-size: 10.5px; font-weight: 600;
    border: 1px solid currentColor;
  }
  .ref.head { color: #66BB6A; }
  .ref.branch { color: #FF8A65; }
  .ref.remote { color: #90A4AE; }
  .ref.tag { color: #FFD54F; }
  .subject { flex: 1 0 35%; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .meta { flex: none; color: var(--muted-foreground, #999); font-size: 11px; }
</style>
</head>
<body>
<header>
  <div class="branch">⎇ ${esc(branch || '—')}</div>
  <div class="sub">${esc(repo ? basename(repo) : 'Sin repositorio')} · ${plural(commitCount, 'commit', 'commits')} · actualizado ${now}</div>
</header>
${error ? `<div class="error">${esc(error)}</div>` : ''}
${!error && !rows.length ? `<div class="hint">Esperando a saber qué worktree mostrar: arranca un agente en Orca o ejecuta <b>Git Graph: Refrescar</b> desde la paleta de comandos.</div>` : ''}
${rows.length ? `<div class="body">${graphSvg(rows, head)}<div class="list">${list}</div></div>` : ''}
</body>
</html>
`
}

// Devuelve el HTML del repo; no escribe nada.
export async function buildPanel(repo) {
  try {
    const [log, head, branch, status] = await Promise.all([
      git(repo, ['log', '--branches', '--remotes', '--tags', 'HEAD', '--date-order', `-n${LIMIT}`, `--format=${LOG_FORMAT}`, '--date=format:%d/%m/%Y %H:%M']),
      git(repo, ['rev-parse', 'HEAD']),
      git(repo, ['branch', '--show-current']),
      // sin --no-optional-locks, status refresca el índice y puede chocar
      // con el git de un agente; en un repo bare falla y se ignora
      git(repo, ['--no-optional-locks', 'status', '--porcelain=v1', '-z']).catch(() => ''),
    ])
    const commits = parseLog(log)
    const changes = parseStatus(status)
    if (changes.length) commits.unshift(wipCommit(changes, head.trim()))
    return renderHtml({
      repo,
      branch: branch.trim() || '(HEAD detached)',
      head: head.trim(),
      rows: layout(commits),
    })
  } catch (e) {
    return renderHtml({ repo, branch: '', head: '', rows: [], error: String(e.stderr || e.message).trim() })
  }
}

// Escribe panel.html solo si el grafo cambió (la hora de la cabecera no cuenta),
// para que Orca no recargue el panel sin motivo.
const withoutClock = html => html.replace(/actualizado [0-9:]+/, '')
export async function writePanel(repo) {
  const html = await buildPanel(repo)
  const current = await readFile(PANEL_PATH, 'utf8').catch(() => '')
  if (withoutClock(current) === withoutClock(html)) return false
  await writeFile(PANEL_PATH, html)
  return true
}

// node render.mjs <repo>   genera el grafo de ese repo
// node render.mjs --reset  deja el panel vacío, como se versiona
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === '--reset') {
    await writeFile(PANEL_PATH, renderHtml({ repo: '', branch: '', head: '', rows: [] }).replace(/ · actualizado [0-9:]+/, ''))
    console.log('panel.html vacío')
  } else {
    const repo = process.argv[2] ?? process.cwd()
    console.log((await writePanel(repo)) ? `panel.html actualizado (${repo})` : 'sin cambios')
  }
}
