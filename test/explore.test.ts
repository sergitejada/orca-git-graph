import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ancestorsOf, branchesOf, emptyFilters, findMatches } from '../src/explore.js'
import type { PanelRow } from '../src/types.js'
import { defaultViewOptions, visibleHistory } from '../src/view-options.js'

const row = (hash: string, parents: string[], refs: string[], author = 'Ana'): PanelRow => ({
  commit: { hash, parents, refs, subject: `commit ${hash}`, author, dateLabel: '1 ene 2026' },
  col: 0, hasIncoming: false, before: [], after: [], joins: [], forks: [],
})
const rows: PanelRow[] = [
  { ...row('WIP', ['a'], []), commit: { hash: 'WIP', parents: ['a'], refs: [], wip: true, changes: [{ x: '?', y: '?', path: 'src/new-feature.ts' }], author: '', subject: 'Cambios sin confirmar', dateLabel: '' } },
  row('a', ['b', 'f'], ['HEAD -> main', 'origin/main']),
  { ...row('f', ['b'], ['feature', 'tag: v1'], 'Bob'), commit: { ...row('f', ['b'], ['feature', 'tag: v1'], 'Bob').commit, message: 'Add feature\n\nHandle navigation', authorEmail: 'bob@example.com' } },
  row('b', [], []),
]

test('las ramas incluyen su historial y los padres de merges', () => {
  assert.deepEqual(branchesOf(rows), ['feature', 'main', 'origin/main'])
  assert.deepEqual(ancestorsOf(rows, 'feature'), new Set(['f', 'b']))
  assert.deepEqual(findMatches(rows, { ...emptyFilters, branch: 'main' }), new Set(['WIP', 'a', 'f', 'b']))
  assert.deepEqual(findMatches(rows, { ...emptyFilters, branch: 'feature' }), new Set(['f', 'b']))
})

test('la búsqueda cubre mensaje completo, email y rutas sin confirmar', () => {
  assert.deepEqual(findMatches(rows, { ...emptyFilters, query: 'BOB navigation' }), new Set(['f']))
  assert.deepEqual(findMatches(rows, { ...emptyFilters, query: 'bob@example.com' }), new Set(['f']))
  assert.deepEqual(findMatches(rows, { ...emptyFilters, query: 'src/new-feature.ts' }), new Set(['WIP']))
})

test('los filtros se combinan y permiten cero resultados', () => {
  assert.deepEqual(findMatches(rows, { ...emptyFilters, mergesOnly: true }), new Set(['a']))
  assert.deepEqual(findMatches(rows, { ...emptyFilters, branch: 'feature', author: 'Bob' }), new Set(['f']))
  assert.deepEqual(findMatches(rows, { ...emptyFilters, branch: 'feature', mergesOnly: true }), new Set())
  assert.deepEqual(findMatches(rows, { ...emptyFilters, query: 'inexistente' }), new Set())
})

test('los stashes se buscan por etiqueta y siguen el filtro de su rama base', () => {
  const stash = { ...row('s', ['f'], []), commit: { ...row('s', ['f'], []).commit, stash: 'stash@{1}' } }
  const history = [stash, ...rows]
  assert.deepEqual(branchesOf(history), branchesOf(rows))
  assert.deepEqual(findMatches(history, { ...emptyFilters, query: 'stash@{1}', branch: 'feature' }), new Set(['s']))
  assert.deepEqual(findMatches(history, { ...emptyFilters, mergesOnly: true }), new Set(['a']))
})

test('las opciones ocultan remotas y stashes conservando ancestros y nombres locales con barras', () => {
  const history = [
    { ...row('s', ['r'], []), commit: { ...row('s', ['r'], []).commit, stash: 'stash@{0}' } },
    row('r', ['b'], ['origin/topic']),
    row('a', ['b'], ['HEAD -> main', 'origin/main', 'feature/local']),
    row('b', [], []),
  ]
  const refs = {
    s: { heads: [], remotes: [], tags: [] },
    r: { heads: [], remotes: [{ name: 'origin/topic', color: '#fff' }], tags: [] },
    a: { heads: [{ name: 'main', active: true, remotes: ['origin'], color: '#fff' }, { name: 'feature/local', active: false, remotes: [], color: '#fff' }], remotes: [], tags: [] },
    b: { heads: [], remotes: [], tags: [] },
  }
  assert.equal(visibleHistory(history, refs, 'a', defaultViewOptions).rows, history)
  const withoutRemotes = visibleHistory(history, refs, 'a', { remoteBranches: false, stashes: true })
  assert.deepEqual(withoutRemotes.rows.map(row => row.commit.hash), ['s', 'r', 'a', 'b'], 'el stash visible conserva su base remota')
  assert.deepEqual(branchesOf(withoutRemotes.rows), ['feature/local', 'main'])
  assert.deepEqual(withoutRemotes.refsByCommit.a.heads[0].remotes, [])
  assert.deepEqual(withoutRemotes.refsByCommit.r.remotes, [])
  const localOnly = visibleHistory(history, refs, 'a', { remoteBranches: false, stashes: false })
  assert.deepEqual(localOnly.rows.map(row => row.commit.hash), ['a', 'b'])
  assert.deepEqual(localOnly.rows[0].commit.parents, ['b'])
  assert.equal(localOnly.rows[1].hasIncoming, true)
  assert.deepEqual(localOnly.rows[0].after, ['b'])
  assert.deepEqual(visibleHistory(history, refs, 'a', { remoteBranches: true, stashes: false }).rows.map(row => row.commit.hash), ['r', 'a', 'b'])
})
