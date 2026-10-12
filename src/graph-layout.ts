import type { Commit, GraphRow } from './types.js'

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

