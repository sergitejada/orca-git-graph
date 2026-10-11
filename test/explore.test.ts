import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ancestorsOf, branchesOf, emptyFilters, findMatches } from '../src/explore.js'
import type { PanelRow } from '../src/types.js'

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
