// Genera panel.html (grafo de commits en SVG) para el panel de Orca.
// Lo usa el worker (main.mjs) y también se puede lanzar a mano:
//   node render.mjs <ruta-del-repo>
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
export const PANEL_PATH = join(HERE, 'panel.html')

const LIMIT = 250
const ROW = 24
const LANE = 16
const PAD = 14
const LOG_FORMAT = '%H%x1f%P%x1f%D%x1f%s%x1f%an%x1f%at%x1e'
// colores por defecto de la extensión Git Graph de VS Code
const PALETTE = ['#0085d9', '#d9008f', '#00d90a', '#d98500', '#a300d9', '#ff0000', '#00d9cc', '#e138e8', '#85d900', '#dc5b23', '#6f24d6', '#ffcc00']
const GREY = '#808080'
const color = lane => PALETTE[lane % PALETTE.length]
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
const two = n => String(n).padStart(2, '0')
export const formatDate = d =>
  `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`

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
      const [hash = '', parents = '', refs = '', subject = '', author = '', time = ''] = record.split('\x1f')
      return {
        hash,
        parents: parents.split(' ').filter(Boolean),
        refs: refs.split(', ').map(r => r.trim()).filter(Boolean),
        subject,
        author,
        date: time ? new Date(Number(time) * 1000) : null,
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
  date: null,
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
  // el carril que une los cambios sin confirmar con HEAD va en gris
  const wipLane = rows[0]?.commit.wip ? rows[0].col : -1
  const stroke = (lane, hash) => (lane === wipLane && hash === head ? GREY : color(lane))
  rows.forEach((row, r) => {
    const top = r * ROW
    const mid = top + ROW / 2
    const bottom = top + ROW
    const cx = x(row.col)
    const line = (d, c) => paths.push(`<path d="${d}" stroke="${c}"/>`)
    // carriles que solo pasan por esta fila
    const width = Math.max(row.before.length, row.after.length)
    for (let i = 0; i < width; i++) {
      if (i === row.col || row.joins.includes(i)) continue
      if (row.before[i] && row.after[i] === row.before[i]) line(`M${x(i)} ${top} V${bottom}`, stroke(i, row.before[i]))
    }
    if (row.hasIncoming) line(`M${cx} ${top} V${mid}`, stroke(row.col, row.commit.hash))
    for (const j of row.joins) line(curve(x(j), top, cx, mid), stroke(j, row.commit.hash))
    if (row.after[row.col]) line(`M${cx} ${mid} V${bottom}`, row.commit.wip ? GREY : color(row.col))
    for (const f of row.forks) {
      line(curve(cx, mid, x(f), bottom), color(f))
      // un carril que ya existía sigue su vertical bajo la curva
      if (row.before[f] && row.before[f] === row.after[f]) line(`M${x(f)} ${top} V${bottom}`, color(f))
    }
    // círculo hueco en los cambios sin confirmar o, si no hay, en HEAD
    const hollow = row.commit.wip || (row.commit.hash === head && wipLane < 0)
    const c = row.commit.wip ? GREY : color(row.col)
    dots.push(
      hollow
        ? `<circle cx="${cx}" cy="${mid}" r="4" fill="var(--background, #1e1e1e)" stroke="${c}" stroke-width="1.5"/>`
        : `<circle cx="${cx}" cy="${mid}" r="4" fill="${c}"/>`,
    )
  })
  const height = rows.length * ROW
  return {
    width,
    svg: `<svg class="graph" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" stroke-width="2" stroke-linecap="round">${paths.join('')}${dots.join('')}</svg>`,
  }
}

// Agrupa las refs de `git log %D` como Git Graph: ramas locales (la remota
// del mismo nombre va dentro de su etiqueta), remotas sueltas y tags.
export function groupRefs(refs, remotes = []) {
  const byLength = [...remotes].sort((a, b) => b.length - a.length)
  const remoteOf = ref => byLength.find(r => ref.startsWith(`${r}/`))
  const heads = []
  const remoteRefs = []
  const tags = []
  for (const ref of refs) {
    if (ref.startsWith('HEAD -> ')) heads.push({ name: ref.slice(8), active: true, remotes: [] })
    else if (ref === 'HEAD') heads.push({ name: 'HEAD', active: true, remotes: [] })
    else if (ref.startsWith('tag: ')) tags.push(ref.slice(5))
    else if (remoteOf(ref)) remoteRefs.push(ref)
    else heads.push({ name: ref, active: false, remotes: [] })
  }
  const loose = remoteRefs.filter(ref => {
    const remote = remoteOf(ref)
    const local = heads.find(h => h.name === ref.slice(remote.length + 1))
    if (!local) return true
    local.remotes.push(remote)
    return false
  })
  return { heads, remotes: loose, tags }
}

// iconos git-branch y tag de Octicons, como en Git Graph
const BRANCH_ICON =
  '<svg viewBox="0 0 10 16"><path d="M10 5c0-1.11-.89-2-2-2a1.993 1.993 0 0 0-1 3.72v.3c-.02.52-.23.98-.63 1.38-.4.4-.86.61-1.38.63-.83.02-1.48.16-2 .45V4.72a1.993 1.993 0 0 0-1-3.72C.88 1 0 1.89 0 3a2 2 0 0 0 1 1.72v6.56c-.59.35-1 .99-1 1.72 0 1.11.89 2 2 2 1.11 0 2-.89 2-2 0-.53-.2-1-.53-1.36.09-.06.48-.41.59-.47.25-.11.56-.17.94-.17 1.05-.05 1.95-.45 2.75-1.25S8.95 7.77 9 6.73h-.02C9.59 6.37 10 5.73 10 5zM2 1.8c.66 0 1.2.55 1.2 1.2 0 .65-.55 1.2-1.2 1.2C1.35 4.2.8 3.65.8 3c0-.65.55-1.2 1.2-1.2zm0 12.41c-.66 0-1.2-.55-1.2-1.2 0-.65.55-1.2 1.2-1.2.65 0 1.2.55 1.2 1.2 0 .65-.55 1.2-1.2 1.2zm6-8c-.66 0-1.2-.55-1.2-1.2 0-.65.55-1.2 1.2-1.2.65 0 1.2.55 1.2 1.2 0 .65-.55 1.2-1.2 1.2z"/></svg>'
const TAG_ICON =
  '<svg viewBox="0 0 14 16"><path d="M7.73 1.73C7.26 1.26 6.62 1 5.96 1H3.5C2.13 1 1 2.13 1 3.5v2.47c0 .66.27 1.3.73 1.77l6.06 6.06c.39.39 1.02.39 1.41 0l4.59-4.59a.996.996 0 0 0 0-1.41L7.73 1.73zM2.38 7.09c-.31-.3-.47-.7-.47-1.13V3.5c0-.88.72-1.59 1.59-1.59h2.47c.42 0 .83.16 1.13.47l6.14 6.13-4.73 4.73-6.13-6.15zM3.01 3h2v2H3V3h.01z"/></svg>'

const refLabel = (icon, c, name, { active = false, remotes = [] } = {}) =>
  `<span class="ref${active ? ' active' : ''}"><span class="ico" style="background:${c}">${icon}</span><span class="name">${esc(name)}</span>${remotes.map(r => `<span class="remote">${esc(r)}</span>`).join('')}</span>`

function refLabels(refs, remotes, c) {
  const g = groupRefs(refs, remotes)
  return [
    ...g.heads.map(h => refLabel(BRANCH_ICON, c, h.name, h)),
    ...g.remotes.map(r => refLabel(BRANCH_ICON, c, r)),
    ...g.tags.map(t => refLabel(TAG_ICON, c, t)),
  ].join('')
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
const MAX_TIP_FILES = 15
const clock = text => `<span class="clock">${text}</span>`

function wipTip(c) {
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
  return `${c.subject}\n${summary.join(' · ')}\n\n${files.join('\n')}`
}

function commitRow(row, head, remotes, now) {
  const c = row.commit
  const cells = (cls, tip, desc, date, author, hash) =>
    `<tr${cls ? ` class="${cls}"` : ''} title="${esc(tip)}"><td class="graph"></td><td class="desc">${desc}</td><td class="date">${date}</td><td class="author">${author}</td><td class="hash">${hash}</td></tr>`
  if (c.wip) {
    return cells('wip', wipTip(c), `<b>${esc(c.subject)} (${c.changes.length})</b>`, now ? clock(formatDate(now)) : '', '*', '*')
  }
  const date = c.date ? formatDate(c.date) : ''
  const tip = `${c.hash} · ${c.author} · ${date}\n\n${c.subject}${c.refs.length ? `\n\n${c.refs.join(', ')}` : ''}`
  const dot = c.hash === head ? `<span class="head-dot" style="border-color:${color(row.col)}" title="HEAD"></span>` : ''
  return cells(
    '',
    tip,
    `${dot}${refLabels(c.refs, remotes, color(row.col))}<span class="subject">${esc(c.subject)}</span>`,
    esc(date),
    esc(c.author),
    esc(c.hash.slice(0, 8)),
  )
}

// `now` es la hora de generación; sin ella (panel versionado) no hay reloj.
export function renderHtml({ repo, branch, head, rows, remotes = [], now = null, error }) {
  const commitCount = rows.filter(row => !row.commit.wip).length
  const graph = rows.length ? graphSvg(rows, head) : null
  const body = rows
    .map(row => commitRow(row, head, remotes, now))
    .join('')
    // el SVG del grafo va en la primera celda y se superpone a las de abajo
    .replace('<td class="graph"></td>', `<td class="graph">${graph?.svg ?? ''}</td>`)
  const grid = 'rgba(128,128,128,.35)'
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
    font-size: 13px;
    color: var(--foreground, #ccc);
    background: var(--background, #1e1e1e);
  }
  header {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px;
    padding: 7px 10px; font-size: 12px;
  }
  header .label { color: var(--muted-foreground, #999); }
  header .sub { margin-left: auto; color: var(--muted-foreground, #999); font-size: 11px; }
  .error { color: #E57373; padding: 10px; white-space: pre-wrap; }
  .hint { color: var(--muted-foreground, #999); padding: 10px; line-height: 1.5; }
  table { width: 100%; border-collapse: separate; border-spacing: 0; }
  th {
    position: sticky; top: 0; z-index: 2;
    height: 26px; padding: 0 10px; white-space: nowrap;
    font-weight: 700; text-align: center;
    background: var(--background, #1e1e1e);
    border-top: 1px solid ${grid}; border-bottom: 1px solid ${grid};
  }
  th + th { border-left: 1px solid ${grid}; }
  td { height: ${ROW}px; padding: 0 6px; white-space: nowrap; }
  td.graph { position: relative; padding: 0; vertical-align: top; }
  td.graph .graph { position: absolute; top: 0; left: 0; z-index: 1; pointer-events: none; }
  td.desc { width: 100%; max-width: 0; overflow: hidden; text-overflow: ellipsis; padding-left: 4px; }
  td.date, td.author, td.hash { padding: 0 6px; }
  tbody tr:hover td { background: rgba(128,128,128,.15); }
  .head-dot {
    display: inline-block; width: 10px; height: 10px; margin-right: 6px; vertical-align: middle;
    border: 2px solid; border-radius: 50%;
  }
  .ref {
    display: inline-flex; height: 18px; margin-right: 5px; vertical-align: middle;
    border: 1px solid rgba(128,128,128,.75); border-radius: 4px; overflow: hidden;
    background: rgba(128,128,128,.12); font-size: 12px; line-height: 16px;
  }
  .ref .ico { display: flex; align-items: center; padding: 0 4px; }
  .ref .ico svg { height: 12px; width: auto; fill: #fff; }
  .ref .name { padding: 0 5px; }
  .ref.active .name { font-weight: 700; }
  .ref .remote { padding: 0 5px; font-style: italic; border-left: 1px solid rgba(128,128,128,.75); }
  .subject { vertical-align: middle; }
  @media (max-width: 560px) { .author { display: none; } }
  @media (max-width: 440px) { .date { display: none; } }
  @media (max-width: 300px) { .hash { display: none; } }
</style>
</head>
<body>
<header>
  <span><span class="label">Repo:</span> <b>${esc(repo ? basename(resolve(repo)) : '—')}</b></span>
  <span><span class="label">Rama:</span> <b>${esc(branch || '—')}</b></span>
  <span class="sub">${plural(commitCount, 'commit', 'commits')}${now ? ` · actualizado ${clock(now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' }))}` : ''}</span>
</header>
${error ? `<div class="error">${esc(error)}</div>` : ''}
${!error && !rows.length ? `<div class="hint">Esperando a saber qué worktree mostrar: arranca un agente en Orca o ejecuta <b>Git Graph: Refrescar</b> desde la paleta de comandos.</div>` : ''}
${rows.length ? `<table>
<thead><tr><th class="graph" style="min-width:${graph.width}px">Grafo</th><th class="desc">Descripción</th><th class="date">Fecha</th><th class="author">Autor</th><th class="hash">Commit</th></tr></thead>
<tbody>${body}</tbody>
</table>` : ''}
</body>
</html>
`
}

// Devuelve el HTML del repo; no escribe nada.
export async function buildPanel(repo) {
  const now = new Date()
  try {
    const [log, head, branch, status, remotes] = await Promise.all([
      git(repo, ['log', '--branches', '--remotes', '--tags', 'HEAD', '--date-order', `-n${LIMIT}`, `--format=${LOG_FORMAT}`]),
      git(repo, ['rev-parse', 'HEAD']),
      git(repo, ['branch', '--show-current']),
      // sin --no-optional-locks, status refresca el índice y puede chocar
      // con el git de un agente; en un repo bare falla y se ignora
      git(repo, ['--no-optional-locks', 'status', '--porcelain=v1', '-z']).catch(() => ''),
      git(repo, ['remote']).catch(() => ''),
    ])
    const commits = parseLog(log)
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
    return renderHtml({ repo, branch: '', head: '', rows: [], now, error: String(e.stderr || e.message).trim() })
  }
}

// Escribe panel.html solo si el grafo cambió (las horas no cuentan),
// para que Orca no recargue el panel sin motivo.
const withoutClock = html => html.replace(/<span class="clock">[^<]*<\/span>/g, '')
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
    await writeFile(PANEL_PATH, renderHtml({ repo: '', branch: '', head: '', rows: [] }))
    console.log('panel.html vacío')
  } else {
    const repo = process.argv[2] ?? process.cwd()
    console.log((await writePanel(repo)) ? `panel.html actualizado (${repo})` : 'sin cambios')
  }
}
