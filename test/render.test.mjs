import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRendererLoader } from '../src/renderer-loader.ts'

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

test('upstream compara refs locales: igualdad, ahead, behind, divergencia y estados sin comparación', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'orca-upstream-'))
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()
  const data = async () => JSON.parse((await buildPanel(repo)).match(/id="git-graph-data">([\s\S]*?)<\/script>/)[1])
  const check = async expected => {
    const panel = await data()
    assert.equal(panel.error, '')
    assert.deepEqual(panel.upstream, expected)
    return panel
  }
  try {
    git('init', '-b', 'main')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.com')
    const empty = await check({ state: 'unborn' })
    assert.equal(empty.branch, 'main')
    assert.deepEqual(empty.rows, [])
    await writeFile(join(repo, 'new.txt'), 'pending')
    assert.equal((await data()).rows[0].commit.wip, true)
    git('add', 'new.txt')
    git('commit', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    await check({ state: 'none' })
    // An unreachable URL proves that reading the panel does not fetch.
    git('remote', 'add', 'origin', join(repo, 'nonexistent-remote'))
    git('config', 'branch.main.remote', 'origin')
    git('config', 'branch.main.merge', 'refs/heads/release/different-name')
    const ref = 'refs/remotes/origin/release/different-name'
    const name = 'origin/release/different-name'
    await check({ state: 'missing', name })
    git('update-ref', ref, base)
    await check({ state: 'tracked', name, ahead: 0, behind: 0 })
    git('commit', '--allow-empty', '-m', 'local ahead')
    const local = git('rev-parse', 'HEAD')
    await check({ state: 'tracked', name, ahead: 1, behind: 0 })
    const tree = git('rev-parse', 'HEAD^{tree}')
    const remote = git('commit-tree', tree, '-p', local, '-m', 'remote ahead')
    git('update-ref', ref, remote)
    await check({ state: 'tracked', name, ahead: 0, behind: 1 })
    git('commit', '--allow-empty', '-m', 'local divergence')
    await check({ state: 'tracked', name, ahead: 1, behind: 1 })
    assert.equal(git('rev-parse', ref), remote)
    git('update-ref', '-d', ref)
    await check({ state: 'missing', name })
    git('switch', '--detach')
    await check({ state: 'detached' })
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

const panelData = html => JSON.parse(html.match(/<script type="application\/json" id="git-graph-data">([\s\S]*?)<\/script>/)[1])

test('Git real: repo vacío, cambios del primer commit y transición al historial', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'orca-unborn-'))
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()
  try {
    git('init', '-b', 'first/branch')
    git('config', 'user.name', 'Ana')
    git('config', 'user.email', 'ana@example.com')
    const emptyHtml = await buildPanel(repo)
    const empty = panelData(emptyHtml)
    assert.equal(empty.error, '')
    assert.equal(empty.unborn, true)
    assert.equal(empty.head, '')
    assert.equal(empty.branch, 'first/branch')
    assert.deepEqual(empty.rows, [])
    assert.match(emptyHtml, /No hay archivos pendientes del primer commit/)
    assert.ok(!emptyHtml.split('<script')[0].includes('Esperando a saber'))

    await writeFile(join(repo, 'staged.txt'), 'first commit\n')
    let data = panelData(await buildPanel(repo))
    assert.deepEqual(data.rows[0].commit.changes, [{ x: '?', y: '?', path: 'staged.txt' }])
    git('add', '--', 'staged.txt')
    data = panelData(await buildPanel(repo))
    assert.equal(data.unborn, true)
    assert.deepEqual(data.rows[0].commit.changes, [{ x: 'A', y: ' ', path: 'staged.txt' }])
    assert.deepEqual(data.rows[0].commit.parents, [])
    await writeFile(join(repo, 'pending.txt'), 'untracked\n')
    const pendingHtml = await buildPanel(repo)
    data = panelData(pendingHtml)
    assert.equal(data.error, '')
    assert.equal(data.unborn, true)
    assert.equal(data.rows.length, 1)
    assert.deepEqual(data.rows[0].commit.changes, [
      { x: 'A', y: ' ', path: 'staged.txt' }, { x: '?', y: '?', path: 'pending.txt' },
    ])
    assert.deepEqual(data.rows[0].commit.parents, [])
    assert.deepEqual(data.rows[0].after, [null])
    assert.equal(data.rows[0].hasIncoming, false)
    assert.deepEqual(data.refsByCommit.WORKING_TREE.heads, [])
    assert.ok(!pendingHtml.match(/<svg class="graph"[^>]*>([\s\S]*?)<\/svg>/)[1].includes('<path'))

    git('-c', 'commit.gpgsign=false', 'commit', '-m', 'First commit')
    data = panelData(await buildPanel(repo))
    assert.equal(data.error, '')
    assert.equal(data.unborn, false)
    assert.equal(data.head, git('rev-parse', 'HEAD'))
    assert.deepEqual(data.rows[0].commit.parents, [data.head])
    assert.equal(data.rows[1].hasIncoming, true)
    assert.equal(data.rows[1].commit.subject, 'First commit')
    assert.deepEqual(data.rows[1].commit.parents, [])
    await rm(join(repo, 'pending.txt'))
    data = panelData(await buildPanel(repo))
    assert.equal(data.unborn, false)
    assert.equal(data.rows.length, 1)
    assert.equal(data.rows[0].commit.hash, data.head)

    // An orphan branch has no HEAD even when other branches have history.
    git('checkout', '--orphan', 'next/branch')
    data = panelData(await buildPanel(repo))
    assert.equal(data.error, '')
    assert.equal(data.unborn, true)
    assert.equal(data.branch, 'next/branch')
    assert.deepEqual(data.rows[0].commit.parents, [])
    assert.equal(data.rows[1].hasIncoming, false)
  } finally { await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('Git real: no confunde rutas no Git ni refs o índices corruptos con una rama sin commits', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'orca-unborn-errors-'))
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()
  const assertError = async () => {
    const html = await buildPanel(repo)
    const data = panelData(html)
    assert.ok(data.error)
    assert.equal(data.unborn, false)
    assert.deepEqual(data.rows, [])
    assert.ok(!html.split('<script')[0].includes('todavía no tiene commits'))
  }
  try {
    await assertError()
    git('init', '-b', 'main')
    await writeFile(join(repo, '.git', 'index'), 'broken index')
    await assertError()
    await rm(join(repo, '.git', 'index'))
    await writeFile(join(repo, '.git', 'refs', 'heads', 'main'), `${'1'.repeat(40)}\n`)
    await assertError()
    await rm(join(repo, '.git', 'refs', 'heads', 'main'))
    await writeFile(join(repo, '.git', 'HEAD'), `${'1'.repeat(40)}\n`)
    await assertError()
  } finally { await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('Git real: los errores de operaciones que requieren worktree no se ocultan', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'orca-unborn-bare-'))
  try {
    execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: repo, windowsHide: true })
    const data = panelData(await buildPanel(repo))
    assert.match(data.error, /work tree/)
    assert.equal(data.unborn, false)
    assert.deepEqual(data.rows, [])
  } finally { await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

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
