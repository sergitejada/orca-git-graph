import { branchesOf, type Filters } from './explore.js'
import { visibleHistory, type ViewOptions } from './view-options.js'
import type { PanelData } from './types.js'
import type { ChangesView } from './changes.js'

// A portable snapshot, not host storage. Orca's public storage methods are
// worker-only and a srcdoc update replaces the entire browsing context.
export const MAX_PANEL_STATE_LENGTH = 32768

export interface PanelState {
  version: 1
  repoPath: string
  filters: Filters
  viewOptions: ViewOptions
  showSearch: boolean
  showFilters: boolean
  selectedHash: string | null
  focusHash: string
  focus: { kind: 'row' | 'control' | 'none'; value: string }
  detailsHeight: number
  changesView: ChangesView
  scroll: { graph: number; details: number }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const string = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
const number = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

export function parsePanelState(text: string, data: PanelData): PanelState {
  if (text.length > MAX_PANEL_STATE_LENGTH) throw new Error('La instantánea es demasiado grande.')
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error('La instantánea no contiene JSON válido.') }
  if (!record(raw) || raw.version !== 1 || !string(raw.repoPath, 8192) || !raw.repoPath ||
    !record(raw.filters) || !string(raw.filters.query, 4096) || !string(raw.filters.branch, 1024) || !string(raw.filters.author, 1024) || typeof raw.filters.mergesOnly !== 'boolean' ||
    !record(raw.viewOptions) || typeof raw.viewOptions.remoteBranches !== 'boolean' || typeof raw.viewOptions.stashes !== 'boolean' ||
    typeof raw.showSearch !== 'boolean' || typeof raw.showFilters !== 'boolean' ||
    !(raw.selectedHash === null || string(raw.selectedHash, 128)) || !string(raw.focusHash, 128) ||
    !record(raw.focus) || typeof raw.focus.kind !== 'string' || !['row', 'control', 'none'].includes(raw.focus.kind) || !string(raw.focus.value, 128) ||
    !number(raw.detailsHeight, 20, 75) || typeof raw.changesView !== 'string' || !['tree', 'list'].includes(raw.changesView) ||
    !record(raw.scroll) || !number(raw.scroll.graph, 0, 10000000) || !number(raw.scroll.details, 0, 10000000)) {
    throw new Error('La instantánea tiene un formato o una versión no válidos.')
  }
  if (raw.repoPath !== data.repoPath) throw new Error('La instantánea pertenece a otro repositorio o worktree.')
  const viewOptions = { remoteBranches: raw.viewOptions.remoteBranches, stashes: raw.viewOptions.stashes }
  const { rows } = visibleHistory(data.rows, data.refsByCommit, data.head, viewOptions)
  const hashes = new Set(rows.map(row => row.commit.hash))
  const selectedHash = raw.selectedHash && hashes.has(raw.selectedHash) ? raw.selectedHash : null
  const fallback = hashes.has(data.head) ? data.head : rows[0]?.commit.hash || ''
  const focusHash = hashes.has(raw.focusHash) ? raw.focusHash : selectedHash || fallback
  const author = raw.filters.author
  // Reconstruct only known fields: imported objects never become props or selectors.
  return {
    version: 1, repoPath: raw.repoPath,
    filters: {
      query: raw.filters.query,
      branch: branchesOf(rows).includes(raw.filters.branch) ? raw.filters.branch : '',
      author: rows.some(row => row.commit.author === author) ? author : '',
      mergesOnly: raw.filters.mergesOnly,
    },
    viewOptions, showSearch: raw.showSearch, showFilters: raw.showFilters,
    selectedHash, focusHash,
    focus: { kind: raw.focus.kind as PanelState['focus']['kind'], value: raw.focus.kind === 'row' && !hashes.has(raw.focus.value) ? focusHash : raw.focus.value },
    detailsHeight: raw.detailsHeight, changesView: raw.changesView as ChangesView,
    scroll: { graph: raw.scroll.graph, details: selectedHash ? raw.scroll.details : 0 },
  }
}
