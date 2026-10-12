import type { Commit, GraphRow } from './types.js'

// Keep Git's order whenever possible, but emit every loaded child before its
// parents. Individually requested ancestors can arrive in any order.
export function orderHistory<T extends Pick<Commit, 'hash' | 'parents'>>(commits: T[]): T[] {
  const positions = new Map(commits.map((commit, index) => [commit.hash, index]))
  const children = commits.map(() => 0)
  for (const commit of commits) {
    for (const parent of commit.parents) {
      const index = positions.get(parent)
      if (index !== undefined) children[index]++
    }
  }
  const ready = commits.map((_commit, index) => index).filter(index => children[index] === 0)
  const ordered: T[] = []
  while (ready.length) {
    const next = ready.shift()
    if (next === undefined) break
    const commit = commits[next]
    ordered.push(commit)
    for (const parent of commit.parents) {
      const index = positions.get(parent)
      if (index === undefined) continue
      if (--children[index] !== 0) continue
      let low = 0
      let high = ready.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (ready[middle] < index) low = middle + 1
        else high = middle
      }
      ready.splice(low, 0, index)
    }
  }
  if (ordered.length !== commits.length) throw new Error('El historial contiene conexiones cíclicas o hashes duplicados.')
  return ordered
}

// Cada carril espera un hash. Un commit ocupa el carril que lo espera; los
// demás que lo esperaban confluyen en él (joins) y cada padre extra abre o
// reutiliza un carril (forks). Los carriles no se desplazan: las verticales
// son rectas y solo confluencias y ramas llevan curva.
export function layout<T extends Pick<Commit, 'hash' | 'parents'>>(commits: T[]): GraphRow<T>[] {
  const lanes: (string | null)[] = []
  const rows: GraphRow<T>[] = []
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
    const joins: number[] = []
    lanes.forEach((h, i) => {
      if (i !== col && h === commit.hash) {
        joins.push(i)
        lanes[i] = null
      }
    })
    const [first, ...rest] = commit.parents
    lanes[col] = first ?? null
    const forks: number[] = []
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

