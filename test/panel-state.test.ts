import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_PANEL_STATE_LENGTH, parsePanelState, type PanelState } from '../src/panel-state.js'
import type { PanelData } from '../src/types.js'

const data: PanelData = {
  repo: 'repo', repoPath: '/repo/worktree', branch: 'main', head: 'a', now: '', error: '', refsByCommit: {},
  rows: [{ commit: { hash: 'a', parents: [], refs: ['HEAD -> main'], author: 'Ana', subject: 'initial', dateLabel: '' }, col: 0, before: [], after: [], joins: [], forks: [], hasIncoming: false }],
}
const snapshot: PanelState = {
  version: 1, repoPath: '/repo/worktree', filters: { query: '<script> & text', branch: 'main', author: 'Ana', mergesOnly: true },
  viewOptions: { remoteBranches: true, stashes: false }, showSearch: true, showFilters: true,
  selectedHash: 'a', focusHash: 'a', focus: { kind: 'row', value: 'a' }, detailsHeight: 65, changesView: 'list', scroll: { graph: 120, details: 80 },
}

test('round trips the complete known state without treating text as HTML', () => {
  assert.deepEqual(parsePanelState(JSON.stringify(snapshot), data), snapshot)
  const extra = JSON.stringify({ ...snapshot, command: 'do not execute', filters: { ...snapshot.filters, injected: true } })
  assert.deepEqual(parsePanelState(extra, data), snapshot)
})

test('isolates repositories and worktrees by their complete path, not basename', () => {
  for (const repoPath of ['/other/worktree', '/repo/other-worktree', '', undefined]) {
    assert.throws(() => parsePanelState(JSON.stringify(snapshot), { ...data, repoPath }), /otro repositorio o worktree/)
  }
})

test('discards vanished selections and stale filters and falls back to HEAD for row focus', () => {
  const stale = { ...snapshot, selectedHash: 'gone', focusHash: 'gone', focus: { kind: 'row', value: 'gone' }, filters: { ...snapshot.filters, branch: 'deleted', author: 'Gone' } }
  const state = parsePanelState(JSON.stringify(stale), data)
  assert.equal(state.selectedHash, null)
  assert.equal(state.focusHash, data.head)
  assert.deepEqual(state.focus, { kind: 'row', value: data.head })
  assert.deepEqual(state.scroll, { graph: 120, details: 0 })
  assert.deepEqual(state.filters, { query: snapshot.filters.query, branch: '', author: '', mergesOnly: true })
  assert.equal(parsePanelState(JSON.stringify(stale), { ...data, head: 'gone' }).focusHash, 'a')
  assert.equal(parsePanelState(JSON.stringify(stale), { ...data, rows: [] }).focusHash, '')
})

test('rejects malformed, oversized, future and unbounded persisted data', () => {
  assert.throws(() => parsePanelState('{', data), /JSON válido/)
  assert.throws(() => parsePanelState(' '.repeat(MAX_PANEL_STATE_LENGTH + 1), data), /demasiado grande/)
  const invalid = [
    null, [], { ...snapshot, version: 2 }, { ...snapshot, filters: null },
    { ...snapshot, filters: { ...snapshot.filters, query: 'x'.repeat(4097) } },
    { ...snapshot, filters: { ...snapshot.filters, mergesOnly: 'true' } },
    { ...snapshot, viewOptions: { remoteBranches: false, stashes: 1 } },
    { ...snapshot, selectedHash: {} }, { ...snapshot, showSearch: 1 },
    { ...snapshot, focus: { kind: ['row'], value: 'a' } },
    { ...snapshot, changesView: ['list'] }, { ...snapshot, detailsHeight: 76 },
    { ...snapshot, detailsHeight: 19 }, { ...snapshot, scroll: { graph: -1, details: 0 } },
    { ...snapshot, scroll: { graph: 0, details: 10000001 } },
  ]
  for (const state of invalid) assert.throws(() => parsePanelState(JSON.stringify(state), data), /formato o una versión/)
})
