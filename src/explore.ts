import type { PanelRow } from './types.js'

export interface Filters {
  query: string
  branch: string
  author: string
  mergesOnly: boolean
}

export const emptyFilters: Filters = { query: '', branch: '', author: '', mergesOnly: false }

const branchName = (ref: string): string | null => {
  if (ref.startsWith('tag: ') || ref === 'HEAD' || ref.endsWith('/HEAD')) return null
  return ref.startsWith('HEAD -> ') ? ref.slice(8) : ref
}

export function branchesOf(rows: PanelRow[]): string[] {
  return [...new Set(rows.flatMap(row => row.commit.refs.map(branchName).filter((name): name is string => name !== null)))].sort()
}

// Recorre solo el historial cargado; un filtro de rama incluye sus antepasados.
export function ancestorsOf(rows: PanelRow[], branch: string): Set<string> {
  const byHash = new Map(rows.map(row => [row.commit.hash, row.commit]))
  const pending = rows.filter(row => row.commit.refs.some(ref => branchName(ref) === branch)).map(row => row.commit.hash)
  const ancestors = new Set<string>()
  while (pending.length) {
    const hash = pending.pop()!
    if (ancestors.has(hash)) continue
    ancestors.add(hash)
    pending.push(...(byHash.get(hash)?.parents || []))
  }
  return ancestors
}

export function findMatches(rows: PanelRow[], filters: Filters): Set<string> {
  const ancestors = filters.branch ? ancestorsOf(rows, filters.branch) : null
  const terms = filters.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return new Set(rows.filter(({ commit }) => {
    if (ancestors && !ancestors.has(commit.hash) && !((commit.wip || commit.stash) && commit.parents.some(parent => ancestors.has(parent)))) return false
    if (filters.author && (commit.wip || commit.author !== filters.author)) return false
    if (filters.mergesOnly && (commit.wip || commit.parents.length < 2)) return false
    const text = [commit.subject, commit.message, commit.author, commit.authorEmail, commit.hash, commit.stash, ...commit.refs,
      ...(commit.wip ? commit.changes.map(change => change.path) : [])].join(' ').toLocaleLowerCase()
    return terms.every(term => text.includes(term))
  }).map(row => row.commit.hash))
}
