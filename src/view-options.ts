import type { PanelRefs, PanelRow } from './types.js'
import { layout } from './graph-layout.js'
import { color } from './graph-style.js'

export interface ViewOptions {
  remoteBranches: boolean
  stashes: boolean
}

export const defaultViewOptions: ViewOptions = { remoteBranches: true, stashes: true }

export function visibleHistory(rows: PanelRow[], refsByCommit: Record<string, PanelRefs>, head: string, options: ViewOptions): {
  rows: PanelRow[]
  refsByCommit: Record<string, PanelRefs>
} {
  if (options.remoteBranches && options.stashes) return { rows, refsByCommit }
  const candidates = rows.filter(row => options.stashes || !row.commit.stash)
  const reachable = new Set<string>()
  if (!options.remoteBranches) {
    const byHash = new Map(candidates.map(row => [row.commit.hash, row.commit]))
    const pending = candidates.filter(({ commit }) => {
      const refs = refsByCommit[commit.hash]
      return commit.wip || commit.hash === head || Boolean(commit.stash) || Boolean(refs?.heads.length || refs?.tags.length)
    }).map(row => row.commit.hash)
    while (pending.length) {
      const hash = pending.pop()
      if (hash === undefined || reachable.has(hash)) continue
      reachable.add(hash)
      pending.push(...(byHash.get(hash)?.parents || []))
    }
  }
  const commits = candidates.filter(row => options.remoteBranches || reachable.has(row.commit.hash)).map(({ commit }) => {
    if (options.remoteBranches) return commit
    const refs = refsByCommit[commit.hash]
    const remoteNames = new Set([
      ...(refs?.remotes.map(ref => ref.name) || []),
      ...(refs?.heads.flatMap(ref => ref.remotes.map(remote => `${remote}/${ref.name}`)) || []),
    ])
    return { ...commit, refs: commit.refs.filter(ref => !remoteNames.has(ref)) }
  })
  const visibleRows = layout(commits)
  const visibleRefs = Object.fromEntries(visibleRows.map(row => {
    const refs = refsByCommit[row.commit.hash] || { heads: [], remotes: [], tags: [] }
    const laneColor = color(row.col)
    return [row.commit.hash, {
      heads: refs.heads.map(ref => ({ ...ref, color: laneColor, remotes: options.remoteBranches ? ref.remotes : [] })),
      remotes: options.remoteBranches ? refs.remotes.map(ref => ({ ...ref, color: laneColor })) : [],
      tags: refs.tags.map(ref => ({ ...ref, color: laneColor })),
    }]
  }))
  return { rows: visibleRows, refsByCommit: visibleRefs }
}
