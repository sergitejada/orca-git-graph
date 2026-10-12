import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRendererLoader } from '../src/renderer-loader.ts'
import { DIFF_LIMITS, loadCommitDiffs, parseDiffFiles } from '../src/commit-diff.ts'

import { buildPanel, groupRefs, layout, panelFingerprint, parseLog, parseStashes, parseStatus, renderHtml, runRepositoryAction, withStashes, wipCommit } from '../render.mjs'

test('refresh y fetch comprueban la selección y descartan el resultado si cambia', async () => {
  let selected = '/repo'
  let failFetch = false
  let switchDuringFetch = false
  const calls = []
  const dependencies = {
    readActiveRepo: async () => selected,
    fetch: async repo => {
      calls.push(['fetch', repo])
      if (failFetch) throw new Error('remote unavailable')
      if (switchDuringFetch) selected = '/other'
    },
    writePanel: async (repo, isCurrent) => {
      if (!await isCurrent()) return false
      calls.push(['publish', repo])
      return true
    },
  }
  await runRepositoryAction('/repo', 'refresh', dependencies)
  assert.deepEqual(calls.splice(0), [['publish', '/repo']])
  await runRepositoryAction('/repo', 'fetch', dependencies)
  assert.deepEqual(calls.splice(0), [['fetch', '/repo'], ['publish', '/repo']])
  selected = '/other'
  await assert.rejects(runRepositoryAction('/repo', 'fetch', dependencies), /seleccionado ha cambiado/)
  assert.deepEqual(calls, [])
  selected = '/repo'
  switchDuringFetch = true
  await runRepositoryAction('/repo', 'fetch', dependencies)
  assert.deepEqual(calls.splice(0), [['fetch', '/repo']])
  selected = '/repo'
  switchDuringFetch = false
  failFetch = true
  await assert.rejects(runRepositoryAction('/repo', 'fetch', dependencies), /remote unavailable/)
  assert.deepEqual(calls, [['fetch', '/repo']])
})

const commit = (hash, parents, extra = {}) => ({
  hash,
  parents,
  refs: [],
  subject: `commit ${hash}`,
  author: 'Ana',
  date: new Date(2026, 0, 1, 10, 0),
  ...extra,
})

// m fusiona f en a; f y a salen de b
const history = [commit('m', ['a', 'f']), commit('f', ['b']), commit('a', ['b']), commit('b', [])]

test('el worker carga el renderizador nuevo sin reiniciar y reutiliza revisiones idénticas', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'git-graph-reload-'))
  try {
    const path = join(directory, 'render.mjs')
    const firstSource = 'export const writePanel = async () => true; export const resetPanel = async () => {}; export const writeLoadingPanel = async () => {}'
    await writeFile(path, firstSource)
    const load = createRendererLoader(pathToFileURL(path))
    const first = await load()
    assert.equal(await first.writePanel('/repo'), true)
    assert.equal(await load(), first)
    await writeFile(path, firstSource.replace('=> true', '=> false'))
    const second = await load()
    assert.notEqual(second, first)
    assert.equal(await second.writePanel('/repo'), false)
    await writeFile(path, firstSource)
    assert.equal(await load(), first)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('los stashes conservan su etiqueta y solo se conectan al primer padre', () => {
  const record = `${['stash@{1}', 's', 'a index untracked', 'refs/stash', 'On main: prueba', 'Ana', '1767261600', 'ana@example.com', 'On main: prueba\n'].join('\x1f')}\x1e`
  const [stash] = parseStashes(record)
  assert.equal(stash.stash, 'stash@{1}')
  assert.deepEqual(stash.parents, ['a'])
  assert.deepEqual(stash.stashParents, ['a', 'index', 'untracked'])
  assert.deepEqual(stash.refs, [])
  const rows = layout(withStashes([commit('a', [])], [stash]))
  assert.deepEqual(rows.map(row => row.commit.hash), ['s', 'a'])
  assert.deepEqual(rows[0].forks, [])
  assert.equal(rows[1].hasIncoming, true)
  const html = renderHtml({ repo: '/repo', branch: 'main', head: 'a', rows })
  assert.ok(html.includes('<span class="name">stash@{1}</span>'))
  assert.ok(!html.includes('<span class="sub">'), 'sin hora no se muestra un resumen de commits o stashes')
})

test('Git carga todos los stashes y sus bases fuera de las ramas, sin snapshots internos', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'orca-stashes-'))
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()
  try {
    git('init', '-b', 'main')
    git('config', 'user.name', 'Ana')
    git('config', 'user.email', 'ana@example.com')
    await writeFile(join(repo, 'file.txt'), 'base')
    git('add', '.')
    git('commit', '-m', 'base')
    const head = git('rev-parse', 'HEAD')
    git('checkout', '--detach')
    await writeFile(join(repo, 'file.txt'), 'detached')
    git('commit', '-am', 'detached base')
    const base = git('rev-parse', 'HEAD')
    await writeFile(join(repo, 'file.txt'), 'first stash')
    await writeFile(join(repo, 'untracked.txt'), 'untracked')
    git('stash', 'push', '-u', '-m', 'primero')
    const first = git('rev-parse', 'refs/stash')
    const internal = [git('rev-parse', 'refs/stash^2'), git('rev-parse', 'refs/stash^3')]
    git('checkout', 'main')
    await writeFile(join(repo, 'file.txt'), 'second stash')
    git('stash', 'push', '-m', 'segundo')
    const second = git('rev-parse', 'refs/stash')
    const html = await buildPanel(repo)
    const payload = JSON.parse(html.match(/id="git-graph-data">([\s\S]*?)<\/script>/)[1])
    const rows = payload.rows
    assert.deepEqual(rows.filter(row => row.commit.stash).map(row => row.commit.stash).sort(), ['stash@{0}', 'stash@{1}'])
    assert.equal(rows.length, 4)
    for (const hash of internal) assert.ok(!rows.some(row => row.commit.hash === hash))
    for (const [stash, parent] of [[first, base], [second, head]]) {
      const index = rows.findIndex(row => row.commit.hash === stash)
      assert.deepEqual(rows[index].commit.parents, [parent])
      assert.ok(index < rows.findIndex(row => row.commit.hash === parent))
    }
    git('stash', 'drop', 'stash@{0}')
    const updated = await buildPanel(repo)
    assert.notEqual(panelFingerprint(html), panelFingerprint(updated))
  } finally { await rm(repo, { recursive: true, force: true }) }
})

test('una rama que sale y vuelve ocupa un segundo carril', () => {
  const rows = layout(history)
  assert.deepEqual(
    rows.map(r => r.col),
    [0, 1, 0, 0],
  )
  assert.deepEqual(rows[0].forks, [1])
  assert.deepEqual(rows[3].joins, [1])
  assert.equal(rows[0].hasIncoming, false)
  assert.equal(rows[2].hasIncoming, true)
})

test('el carril de la rama se libera tras confluir', () => {
  const rows = layout([...history.slice(0, 3), commit('b', ['z']), commit('z', [])])
  assert.deepEqual(rows[4].before, ['z'])
})

test('el HTML escapa el texto de los commits', () => {
  const html = renderHtml({
    repo: '/tmp/repo',
    branch: 'main',
    head: 'm',
    rows: layout([commit('m', [], { subject: '<script>x</script>', refs: ['HEAD -> main'] })]),
  })
  assert.ok(!html.includes('<script>x'))
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(html.includes('<span class="name">main</span>'))
  assert.ok(html.includes('1 ene 2026 10:00'))
})

test('sin commits muestra el aviso de espera', () => {
  const html = renderHtml({ repo: '', branch: '', head: '', rows: [] })
  assert.ok(html.includes('Git Graph: Refrescar'))
})

test('parseStatus descarta la ruta original de los renombrados', () => {
  const changes = parseStatus('RM d.txt\0a.txt\0?? b c.txt\0 M src/x.js\0')
  assert.deepEqual(
    changes.map(c => `${c.x}${c.y}|${c.path}`),
    ['RM|d.txt', '??|b c.txt', ' M|src/x.js'],
  )
  assert.deepEqual(parseStatus(''), [])
})

test('los cambios sin confirmar van arriba, unidos a HEAD con línea gris', () => {
  const changes = parseStatus(' M a.txt\0?? b.txt\0')
  // HEAD (a) no es el commit más reciente: f es de otra rama
  const commits = [wipCommit(changes, 'a'), commit('f', ['b']), commit('a', ['b']), commit('b', [])]
  const rows = layout(commits)
  assert.deepEqual(rows.map(r => r.col), [0, 1, 0, 0])
  assert.equal(rows[2].hasIncoming, true)
  const now = new Date(2026, 9, 11, 23, 12)
  const html = renderHtml({ repo: '/tmp/repo', branch: 'main', head: 'a', rows, now })
  assert.ok(html.includes('<b>Cambios sin confirmar (2)</b>'))
  assert.ok(html.includes('<span class="clock">11 oct 2026 23:12</span>'))
  assert.ok(html.includes('1 sin preparar · 1 sin seguimiento'))
  assert.ok(!html.includes('3 commits'), 'la cabecera no muestra el contador de commits')
  // salida del nodo, paso por la fila de f y llegada a HEAD
  assert.equal(html.match(/<path [^>]*stroke="#808080"/g).length, 3)
  // el nodo hueco es el de los cambios sin confirmar; HEAD se marca en la descripción
  assert.equal(html.match(/<circle [^>]*stroke=/g).length, 1)
  assert.equal(html.match(/class="head-dot"/g).length, 1)
})

test('sin cambios sin confirmar, el nodo hueco es HEAD', () => {
  const html = renderHtml({ repo: '/tmp/repo', branch: 'main', head: 'm', rows: layout(history) })
  assert.equal(html.match(/<circle [^>]*stroke=/g).length, 1)
  assert.ok(html.match(/<circle [^>]*stroke=/)[0].includes('cy="12"'))
})

test('groupRefs mete la remota del mismo nombre en la etiqueta local', () => {
  const g = groupRefs(['HEAD -> main', 'origin/main', 'origin/HEAD', 'feature/x', 'tag: v1'], ['origin'])
  assert.deepEqual(g.heads, [
    { name: 'main', active: true, remotes: ['origin'] },
    { name: 'feature/x', active: false, remotes: [] },
  ])
  assert.deepEqual(g.remotes, ['origin/HEAD'])
  assert.deepEqual(g.tags, ['v1'])
})

test('el panel incluye sus assets inline y serializa el texto sin cerrar el script', () => {
  const subject = '</script><img src=x onerror=alert(1)>'
  const html = renderHtml({ repo: '/repo', branch: 'main', head: 'a', rows: layout([commit('a', [], { subject })]) })
  assert.match(html, /<style>[\s\S]*font-size:13px[\s\S]*<\/style>/)
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=/)
  assert.doesNotMatch(html, /<img src=x/)
  const json = html.match(/<script type="application\/json" id="git-graph-data">([\s\S]*?)<\/script>/)[1]
  assert.equal(JSON.parse(json).rows[0].commit.subject, subject)
})

test('el reloj no provoca recargas; los cambios reales del grafo sí', () => {
  const changes = parseStatus(' M a.txt\0')
  const options = { repo: '/repo', branch: 'main', head: 'a', rows: layout([wipCommit(changes, 'a'), commit('a', [])]) }
  const first = renderHtml({ ...options, now: new Date(2026, 0, 1, 23, 59) })
  const later = renderHtml({ ...options, now: new Date(2026, 0, 2, 0, 1) })
  assert.equal(panelFingerprint(first), panelFingerprint(later))
  const updated = renderHtml({ ...options, branch: 'other', now: new Date(2026, 0, 2, 0, 1) })
  assert.notEqual(panelFingerprint(first), panelFingerprint(updated))
})

test('git log conserva el mensaje completo y el email para los detalles', () => {
  const log = `${['abc', 'parent', 'HEAD -> main', 'Asunto', 'Ana', '1767261600', 'ana@example.com', 'Asunto\n\nCuerpo con varias líneas\nSegunda línea\n'].join('\x1f')}\x1e`
  const [commit] = parseLog(log)
  assert.equal(commit.message, 'Asunto\n\nCuerpo con varias líneas\nSegunda línea')
  assert.equal(commit.authorEmail, 'ana@example.com')
  const html = renderHtml({ repo: '/repo', branch: 'main', head: 'abc', rows: layout([commit]) })
  const json = html.match(/<script type="application\/json" id="git-graph-data">([\s\S]*?)<\/script>/)[1]
  assert.equal(JSON.parse(json).rows[0].commit.message, commit.message)
})

test('los metadatos NUL conservan rutas especiales y no aceptan registros incompletos', () => {
  const header = ':100644 100644 aaaaa bbbbb R100'
  const [file] = parseDiffFiles(`${header}\0old\t\nname\0:(glob)<script> & café\0`)
  assert.equal(file.oldPath, 'old\t\nname')
  assert.equal(file.path, ':(glob)<script> & café')
  assert.equal(file.status, 'R100')
  assert.deepEqual(parseDiffFiles(`${header}\0old\0incomplete`), [])
})

test('Git lee raíz, renombrados, binarios, cada padre de un merge y snapshots del stash', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'orca-commit-diff-'))
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()
  try {
    git('init', '-b', 'main')
    git('config', 'user.name', 'Ana')
    git('config', 'user.email', 'ana@example.com')
    git('config', 'core.autocrlf', 'false')
    git('config', 'diff.external', 'invalid-external-diff-command')
    git('config', 'diff.test.textconv', 'invalid-textconv-command')
    await writeFile(join(repo, '.gitattributes'), '*.txt diff=test\n')
    await writeFile(join(repo, '--odd & café [1].txt'), 'original\n')
    await writeFile(join(repo, 'binary.bin'), Buffer.from([0, 255, 1, 2]))
    git('add', '--', '.')
    git('commit', '-m', 'root')
    const root = git('rev-parse', 'HEAD')
    git('mv', '--', '--odd & café [1].txt', 'renamed & café.txt')
    git('commit', '-m', 'rename')
    const renamed = git('rev-parse', 'HEAD')
    git('checkout', '-b', 'topic')
    await writeFile(join(repo, 'topic.txt'), 'topic\n')
    git('add', '.')
    git('commit', '-m', 'topic')
    const topic = git('rev-parse', 'HEAD')
    git('checkout', 'main')
    await writeFile(join(repo, 'main.txt'), 'main\n')
    git('add', '.')
    git('commit', '-m', 'main')
    const main = git('rev-parse', 'HEAD')
    git('merge', '--no-ff', 'topic', '-m', 'merge')
    const merge = git('rev-parse', 'HEAD')
    await writeFile(join(repo, 'main.txt'), 'staged\n')
    git('add', '--', 'main.txt')
    await writeFile(join(repo, 'main.txt'), 'working\n')
    await writeFile(join(repo, 'untracked.txt'), 'untracked\n')
    git('stash', 'push', '-u', '-m', 'snapshot')
    const stash = git('rev-parse', 'refs/stash')
    const payload = JSON.parse((await buildPanel(repo)).match(/id="git-graph-data">([\s\S]*?)<\/script>/)[1])
    assert.equal(payload.error, '')
    const data = hash => payload.rows.find(row => row.commit.hash === hash).commit
    const rootDiff = data(root).comparisons[0]
    assert.equal(rootDiff.base, null)
    assert.equal(rootDiff.files.find(file => file.path === 'binary.bin').binary, true)
    assert.match(rootDiff.files.find(file => file.path === '--odd & café [1].txt').patch, /\+original/)
    const rename = data(renamed).comparisons[0].files[0]
    assert.equal(rename.oldPath, '--odd & café [1].txt')
    assert.equal(rename.path, 'renamed & café.txt')
    assert.equal(rename.status, 'R100')
    assert.match(rename.patch, /rename from/)
    const mergeDiffs = data(merge).comparisons
    assert.deepEqual(mergeDiffs.map(diff => diff.base), [main, topic])
    assert.deepEqual(mergeDiffs[0].files.map(file => file.path), ['topic.txt'])
    assert.deepEqual(mergeDiffs[1].files.map(file => file.path), ['main.txt'])
    const stashDiffs = data(stash).comparisons
    assert.equal(stashDiffs.length, 3)
    assert.match(stashDiffs[0].files[0].patch, /\+working/)
    assert.match(stashDiffs[1].files[0].patch, /\+staged/)
    assert.deepEqual(stashDiffs[2].files.map(file => file.path), ['untracked.txt'])
    assert.equal(stashDiffs[2].base, null)
    assert.deepEqual(data(stash).parents, [merge])
    assert.ok(!payload.rows.some(row => row.commit.hash === stashDiffs[1].target))
    const octopusHash = git('commit-tree', `${merge}^{tree}`, '-p', root, '-p', renamed, '-p', topic, '-p', main, '-p', merge, '-m', 'octopus')
    const octopus = commit(octopusHash, [root, renamed, topic, main, merge])
    await loadCommitDiffs(repo, [octopus])
    assert.equal(octopus.comparisons.length, 4)
    assert.match(octopus.diffNotice, /primeros 4 padres/)
    const rootCommit = commit(root, [])
    await loadCommitDiffs(repo, [rootCommit])
    await rm(join(repo, '.git'), { recursive: true, force: true })
    const cached = commit(root, [])
    await loadCommitDiffs(repo, [cached])
    assert.strictEqual(cached.comparisons[0].files, rootCommit.comparisons[0].files, 'no vuelve a ejecutar Git en el refresco')
    const pending = [commit(root, []), commit(root, [])]
    const originalNow = Date.now
    const times = [0, 0, DIFF_LIMITS.loadMs + 1]
    try {
      Date.now = () => times.shift() ?? DIFF_LIMITS.loadMs + 1
      await loadCommitDiffs(repo, pending)
    } finally { Date.now = originalNow }
    assert.equal(pending[0].comparisons.length, 1)
    assert.equal(pending[1].comparisons.length, 0)
    assert.match(pending[1].diffNotice, /15 segundos/)
    await loadCommitDiffs(repo, pending)
    assert.equal(pending[1].comparisons.length, 1)
    assert.equal(pending[1].diffNotice, undefined)
    const otherRepo = commit(root, [])
    await loadCommitDiffs(join(repo, 'missing'), [otherRepo])
    assert.equal(otherRepo.comparisons[0].files.length, 0, 'la caché no mezcla repositorios')
    assert.ok(otherRepo.comparisons[0].notice)
    const repeated = Array.from({ length: 301 }, () => commit(root, []))
    await loadCommitDiffs(repo, repeated)
    assert.equal(repeated[299].comparisons.length, 1)
    assert.equal(repeated[300].comparisons.length, 0)
    assert.match(repeated[300].diffNotice, /300 comparaciones/)
  } finally { await rm(repo, { recursive: true, force: true }) }
})

test('listas y diffs grandes se recortan con avisos visibles y presupuesto de panel', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'orca-diff-limits-'))
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()
  try {
    git('init', '-b', 'main')
    git('config', 'user.name', 'Ana')
    git('config', 'user.email', 'ana@example.com')
    git('config', 'core.autocrlf', 'false')
    await writeFile(join(repo, 'a-large.txt'), 'é😀'.repeat(100000))
    for (let index = 0; index < 105; index++) await writeFile(join(repo, `file-${index}.txt`), 'small\n')
    git('add', '.')
    git('commit', '-m', 'large')
    const hash = git('rev-parse', 'HEAD')
    const item = commit(hash, [])
    await loadCommitDiffs(repo, [item])
    const diff = item.comparisons[0]
    assert.equal(diff.files.length, DIFF_LIMITS.files)
    assert.match(diff.notice, /100 archivos/)
    assert.match(diff.notice, /64 KiB/)
    assert.ok(diff.files[0].patch.length <= DIFF_LIMITS.patch)
    assert.ok(Buffer.byteLength(diff.files[0].patch) <= DIFF_LIMITS.patch)
    assert.ok(!diff.files[0].patch.includes('\uFFFD'), 'el recorte conserva caracteres UTF-8 completos')
    assert.match(diff.files[0].notice, /recortado/)
    assert.match(diff.files[1].notice, /no incluido/)
    const repeated = Array.from({ length: 300 }, () => commit(hash, []))
    await loadCommitDiffs(repo, repeated)
    const bytes = repeated.reduce((sum, row) => sum + row.comparisons.reduce((total, comparison) => total + Buffer.byteLength(JSON.stringify(comparison)), 0), 0)
    assert.ok(bytes <= DIFF_LIMITS.payload)
    assert.match(repeated.at(-1).diffNotice, /4 MiB/)
    await writeFile(join(repo, 'lines.txt'), Array.from({ length: 700 }, (_, index) => `line ${index}`).join('\n'))
    git('add', '--', 'lines.txt')
    git('commit', '-m', 'many lines')
    const lines = commit(git('rev-parse', 'HEAD'), [hash])
    await loadCommitDiffs(repo, [lines])
    assert.match(lines.comparisons[0].files[0].notice, /600 líneas/)
    assert.ok(lines.comparisons[0].files[0].patch.split('\n').length <= DIFF_LIMITS.lines)
  } finally { await rm(repo, { recursive: true, force: true }) }
})
