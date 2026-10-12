import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, rm, copyFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRendererLoader } from '../src/renderer-loader.ts'
import { DIFF_LIMITS, loadCommitDiffs, parseDiffFiles } from '../src/commit-diff.ts'

import { buildPanel, createPanelBuilder, groupRefs, layout, panelFingerprint, parseLog, parseStashes, parseStatus, renderHtml, runRepositoryAction, withStashes, wipCommit } from '../render.mjs'

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

function cachedBuilder() {
  const state = { head: 'a\n', branch: 'main\n', refs: 'main a', stash: '', status: '', remotes: 'origin\n' }
  const calls = []
  let layouts = 0
  let failStatus = false
  let beforeLog = async () => {}
  const record = `${['a', '', 'HEAD -> main', 'base', 'Ana', '1767261600', 'ana@example.com', 'base'].join('\x1f')}\x1e`
  const builder = createPanelBuilder({
    git: async (repo, args) => {
      calls.push({ repo, args })
      if (args[0] === 'log') { await beforeLog(repo); return record }
      if (args[0] === 'stash') return state.stash
      if (args[0] === 'rev-parse') return args.includes('--is-bare-repository') ? 'false\n.git/shallow\n' : state.head
      if (args[0] === 'branch') return state.branch
      // readUpstream solo consulta refs/heads/ cuando se recalcula el historial.
      if (args[0] === 'for-each-ref') return args.includes('refs/heads/') ? '' : state.refs
      if (args[0] === '--no-optional-locks') {
        if (failStatus) throw new Error('index read failed')
        return state.status
      }
      if (args[0] === 'remote') return state.remotes
      throw new Error(`unexpected Git: ${args}`)
    },
    layout: commits => { layouts++; return layout(commits) },
    loadCommitDiffs: async () => {},
  })
  return { ...builder, state, calls, layouts: () => layouts, logs: () => calls.filter(call => call.args[0] === 'log').length,
    failStatus: value => { failStatus = value }, beforeLog: handler => { beforeLog = handler } }
}

const payloadOf = html => JSON.parse(html.match(/id="git-graph-data">([\s\S]*?)<\/script>/)[1])

test('refrescos normales consultan Git y reutilizan historial y ambos layouts para índice/untracked', async () => {
  const b = cachedBuilder()
  await b.build('/a')
  assert.equal(b.calls.length, 9)
  assert.equal(b.layouts(), 1)
  await b.build('/a')
  assert.equal(b.calls.length, 16, 'siete consultas actuales, sin upstream ni git log')
  assert.equal(b.layouts(), 1)
  b.state.status = '?? directory/untracked.txt\0'
  const working = payloadOf(await b.build('/a'))
  assert.equal(working.rows[0].commit.changes[0].path, 'directory/untracked.txt')
  assert.equal(b.layouts(), 2)
  b.state.status = 'A  directory/untracked.txt\0 M tracked.txt\0'
  const staged = payloadOf(await b.build('/a'))
  assert.equal(staged.rows[0].commit.changes[0].x, 'A')
  assert.deepEqual(staged.rows.slice(1), working.rows.slice(1))
  assert.equal(b.layouts(), 2, 'cambiar paths/índice conserva carriles')
  b.state.status = ''
  await b.build('/a')
  assert.equal(b.layouts(), 2, 'recupera layout limpio')
  assert.equal(b.logs(), 1)
  assert.ok(b.calls.filter(call => call.args[0] === '--no-optional-locks').every(call => call.args.includes('--untracked-files=all')))
})

test('invalida por HEAD, rama, refs locales/remotas/tags, remotas, stash completo, rango, repo y manual', async () => {
  const b = cachedBuilder()
  await b.build('/a')
  const mutations = [
    () => { b.state.head = 'b\n' },
    () => { b.state.branch = 'other\n' },
    () => { b.state.refs += '\nrefs/heads/new b' },
    () => { b.state.refs += '\nrefs/remotes/origin/main b' },
    () => { b.state.refs += '\nrefs/tags/v1 b' },
    () => { b.state.remotes = 'upstream\n' },
    () => { b.state.stash = `stash@{0}\x1f${['s', 'a index', '', 'stash', 'Ana', '1767261600', 'a@b', 'stash'].join('\x1f')}\x1e` },
    // Cambia un stash antiguo sin mover la punta de refs/stash.
    () => { b.state.stash += b.state.stash.replace('stash@{0}', 'stash@{1}').replace('\x1fs\x1f', '\x1fold\x1f') },
    () => { b.state.stash = '' },
  ]
  for (const mutate of mutations) {
    const logs = b.logs()
    mutate()
    await b.build('/a')
    assert.equal(b.logs(), logs + 1)
    await b.build('/a')
    assert.equal(b.logs(), logs + 1)
  }
  let logs = b.logs()
  const range = { repo: '/a', session: 's', limit: 500, targets: [] }
  await b.build('/a', range)
  await b.build('/a', range)
  await b.build('/a', { ...range, targets: ['b'.repeat(40)] })
  assert.equal(b.logs(), logs + 3, 'cada rango recalcula el historial y busca el padre solicitado')
  logs = b.logs()
  await b.build('/b')
  await b.build('/a')
  assert.equal(b.logs(), logs + 2)
  logs = b.logs()
  await b.build('/a', undefined, true)
  b.invalidate()
  await b.build('/a')
  assert.equal(b.logs(), logs + 2)
})

test('una lectura antigua concurrente no repone la caché de un repo abandonado', async () => {
  const b = cachedBuilder()
  let finish
  const gate = new Promise(resolve => { finish = resolve })
  b.beforeLog(repo => repo === '/a' ? gate : Promise.resolve())
  const old = b.build('/a')
  await new Promise(resolve => setImmediate(resolve))
  await b.build('/b')
  finish()
  await old
  const logs = b.logs()
  await b.build('/b')
  assert.equal(b.logs(), logs)
  await b.build('/a')
  assert.equal(b.logs(), logs + 1)
})

test('un fallo leyendo índice no se presenta como árbol limpio y permite reintentar sin caché', async () => {
  const b = cachedBuilder()
  await b.build('/a')
  b.failStatus(true)
  assert.equal(payloadOf(await b.build('/a')).error, 'index read failed')
  b.failStatus(false)
  b.state.status = 'M  tracked.txt\0'
  assert.equal(payloadOf(await b.build('/a')).rows[0].commit.changes[0].x, 'M')
  assert.equal(b.logs(), 2)
})

test('Git externo: índice, untracked, refs empaquetadas y fetch --deepen sin mover HEAD', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'git-graph-cache-'))
  const source = join(directory, 'source')
  const repo = join(directory, 'clone')
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  let logs = 0
  const builder = createPanelBuilder({
    git: async (cwd, args) => { if (args[0] === 'log') logs++; return git(cwd, ...args) },
    layout,
    loadCommitDiffs,
  })
  try {
    await mkdir(source)
    git(source, 'init', '-b', 'main')
    git(source, 'config', 'user.name', 'Ana')
    git(source, 'config', 'user.email', 'ana@example.com')
    for (let i = 0; i < 3; i++) {
      await writeFile(join(source, 'tracked.txt'), String(i))
      git(source, 'add', '.')
      git(source, 'commit', '-m', `commit ${i}`)
    }
    git(directory, 'clone', '--depth=1', pathToFileURL(source).href, repo)
    const head = git(repo, 'rev-parse', 'HEAD')
    assert.equal(payloadOf(await builder.build(repo)).rows.length, 1)
    await mkdir(join(repo, 'new'))
    await writeFile(join(repo, 'new', 'untracked.txt'), 'new')
    let payload = payloadOf(await builder.build(repo))
    assert.deepEqual(payload.rows[0].commit.changes, [{ x: '?', y: '?', path: 'new/untracked.txt' }])
    git(repo, 'add', 'new/untracked.txt')
    payload = payloadOf(await builder.build(repo))
    assert.equal(payload.rows[0].commit.changes[0].x, 'A')
    assert.equal(logs, 1)
    git(repo, 'branch', 'external')
    git(repo, 'tag', 'external-tag')
    git(repo, 'pack-refs', '--all', '--prune')
    payload = payloadOf(await builder.build(repo))
    assert.ok(payload.rows.some(row => row.commit.refs.includes('external') && row.commit.refs.includes('tag: external-tag')))
    assert.equal(logs, 2)
    git(repo, 'fetch', '--deepen=1')
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head)
    payload = payloadOf(await builder.build(repo))
    assert.equal(payload.rows.filter(row => !row.commit.wip).length, 2)
    assert.equal(logs, 3)
    git(repo, 'checkout', '--detach')
    assert.equal(payloadOf(await builder.build(repo)).branch, '(HEAD detached)')
    assert.equal(logs, 4)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

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
    const firstSource = 'export let invalidations = 0; export const invalidatePanelCache = () => { invalidations++ }; export const writePanel = async () => true; export const resetPanel = async () => {}; export const writeLoadingPanel = async () => {}'
    await writeFile(path, firstSource)
    const load = createRendererLoader(pathToFileURL(path))
    const first = await load()
    assert.equal(first.invalidations, 1)
    assert.equal(await first.writePanel('/repo'), true)
    assert.equal(await load(), first)
    assert.equal(first.invalidations, 1)
    await writeFile(path, firstSource.replace('=> true', '=> false'))
    const second = await load()
    assert.equal(second.invalidations, 1)
    assert.notEqual(second, first)
    assert.equal(await second.writePanel('/repo'), false)
    await writeFile(path, firstSource)
    assert.equal(await load(), first)
    assert.equal(first.invalidations, 2, 'volver a una revisión anterior también invalida su caché')
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

test('los padres externos conservan el orden topológico aunque se solicite primero un ancestro compartido', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'git-graph-history-order-'))
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()
  try {
    git('init', '-q', '-b', 'main')
    let input = ''
    const add = (ref, mark, parent, date, name) => {
      const message = `${name}\n`
      input += `commit refs/heads/${ref}\nmark :${mark}\ncommitter Test <test@example.com> ${date} +0000\ndata ${Buffer.byteLength(message)}\n${message}${parent ? `from :${parent}\n` : ''}\n`
    }
    add('base', 1, 0, 1700000000, 'shared ancestor')
    add('child', 2, 1, 1700000001, 'child of shared ancestor')
    for (let i = 3; i <= 302; i++) add('main', i, i === 3 ? 1 : i - 1, 1700000000 + i, `filler ${i}`)
    add('a', 303, 1, 1700001001, 'branch A')
    add('b', 304, 2, 1700001000, 'branch B')
    execFileSync('git', ['fast-import', '--quiet'], { cwd: repo, input, windowsHide: true })
    const ancestor = git('rev-parse', 'base')
    const child = git('rev-parse', 'child')
    const initial = panelData(await buildPanel(repo))
    assert.equal(initial.rows.some(row => [ancestor, child].includes(row.commit.hash)), false)
    const expanded = panelData(await buildPanel(repo, { repo, session: 'order-test', limit: 250, targets: [ancestor, child], focus: child }))
    assert.equal(expanded.error, '')
    const positions = new Map(expanded.rows.map((row, index) => [row.commit.hash, index]))
    for (const row of expanded.rows) {
      for (const parent of row.commit.parents) {
        if (positions.has(parent)) assert.ok(positions.get(row.commit.hash) < positions.get(parent), `${row.commit.subject} must precede its parent`)
      }
    }
    const parentRow = expanded.rows.find(row => row.commit.hash === ancestor)
    assert.ok(parentRow.joins.length > 0, 'both branches connect to their shared ancestor')
    assert.deepEqual(expanded.rows.find(row => row.commit.hash === child).commit.parents, [ancestor])
  } finally { await rm(repo, { recursive: true, force: true }) }
})

test('carga bloques de más de 250 commits, ramas, stashes y padres externos sin duplicados', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'git-graph-history-'))
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()
  const data = html => JSON.parse(html.match(/id="git-graph-data">([\s\S]*?)<\/script>/)[1])
  try {
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'History Test')
    git('config', 'user.email', 'history@example.com')
    let input = ''
    for (let i = 1; i <= 620; i++) {
      const message = `commit ${i}\n`
      input += `commit refs/heads/main\nmark :${i}\ncommitter History Test <history@example.com> ${1700000000 + i} +0000\ndata ${Buffer.byteLength(message)}\n${message}${i > 1 ? `from :${i - 1}\n` : ''}\n`
    }
    execFileSync('git', ['fast-import', '--quiet'], { cwd: repo, input, windowsHide: true })
    git('reset', '--hard', 'HEAD')
    git('branch', 'older-branch', 'HEAD~400')
    const side = git('commit-tree', 'HEAD~400^{tree}', '-p', 'HEAD~400', '-m', 'divergent side commit')
    git('update-ref', 'refs/heads/side-branch', side)
    const merge = git('commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-p', side, '-m', 'merge side history')
    git('update-ref', 'refs/heads/main', merge)
    git('reset', '--hard', 'HEAD')
    await writeFile(join(repo, 'stash.txt'), 'stash content')
    git('stash', 'push', '-u', '-m', 'history stash')
    const initial = data(await buildPanel(repo))
    const ordinary = panel => panel.rows.filter(row => !row.commit.wip && !row.commit.stash)
    assert.equal(ordinary(initial).length, 250)
    assert.equal(ordinary(initial)[0].commit.parents.length, 2)
    assert.ok(initial.rows.some(row => row.col > 0))
    assert.equal(initial.history.incomplete, true)
    assert.equal(initial.rows.filter(row => row.commit.stash).length, 1)
    const boundary = ordinary(initial).at(-1).commit
    const parent = boundary.parents[0]
    assert.ok(parent)
    assert.equal(initial.rows.some(row => row.commit.hash === parent), false)
    const state = { repo, session: 'test-session', limit: 500, targets: [] }
    const expanded = data(await buildPanel(repo, state))
    assert.equal(ordinary(expanded).length, 500)
    assert.ok(initial.rows.every(row => expanded.rows.some(next => next.commit.hash === row.commit.hash)))
    assert.ok(expanded.rows.some(row => row.commit.refs.includes('older-branch')))
    const targeted = data(await buildPanel(repo, { ...state, limit: 250, targets: [parent, parent], focus: parent }))
    assert.equal(ordinary(targeted).length, 251)
    assert.deepEqual(targeted.rows.find(row => row.commit.hash === boundary.hash).commit.parents, boundary.parents)
    assert.equal(new Set(targeted.rows.map(row => row.commit.hash)).size, targeted.rows.length)
    const full = data(await buildPanel(repo, { ...state, limit: 750 }))
    assert.equal(ordinary(full).length, 622)
    assert.equal(full.history.incomplete, false)
    assert.equal(full.rows.filter(row => row.commit.stash).length, 1)
    const missing = data(await buildPanel(repo, { ...state, targets: ['f'.repeat(40)] }))
    assert.ok(missing.history.notice.includes('no está disponible'))

    // Isolated plugin files: exercise the real terminal mailbox and renderer, never the shared panel.
    const plugin = join(repo, 'plugin-test')
    await mkdir(plugin)
    await copyFile(new URL('../render.mjs', import.meta.url), join(plugin, 'render.mjs'))
    const renderer = await import(pathToFileURL(join(plugin, 'render.mjs')).href)
    const session = await renderer.resetHistory(repo)
    const request = { session: session.session, limit: 250 }
    await renderer.runHistoryAction(repo, request, async () => repo)
    await Promise.all([renderer.writePanel(repo, async () => true, true), renderer.writePanel(repo, async () => true, true)])
    const stored = () => readFile(join(plugin, 'history.state.json'), 'utf8').then(JSON.parse)
    assert.equal((await stored()).limit, 500)
    const published = data(await readFile(join(plugin, 'panel.html'), 'utf8'))
    assert.equal(ordinary(published).length, 500)
    await assert.rejects(renderer.runHistoryAction(repo, request, async () => repo), /historial ha cambiado/)
    await assert.rejects(renderer.runHistoryAction(repo, { ...request, limit: 500 }, async () => '/other'), /seleccionado ha cambiado/)
    await renderer.resetHistory('/other')
    assert.equal(await renderer.writePanel(repo, async () => false, true), false)
    assert.equal((await stored()).repo, '/other')
    await renderer.resetHistory(repo)
    await renderer.writePanel(repo, async () => true, true)
    assert.equal((await stored()).limit, 250, 'the old mailbox cannot expand a new selection session')

  } finally { await rm(repo, { recursive: true, force: true }) }
})
