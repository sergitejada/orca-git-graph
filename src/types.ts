export interface Change {
  x: string
  y: string
  path: string
}

interface CommitBase {
  stash?: string
  stashParents?: string[]
  comparisons?: CommitComparison[]
  diffNotice?: string
  hash: string
  parents: string[]
  refs: string[]
  subject: string
  author: string
  date: Date | null
  message?: string
  authorEmail?: string
}

export interface CommitFile {
  path: string
  oldPath?: string
  status: string
  patch: string
  binary: boolean
  notice?: string
}

export interface CommitComparison {
  label: string
  base: string | null
  target: string
  files: CommitFile[]
  notice?: string
}

export interface GitCommit extends CommitBase {
  wip?: false
}

export interface WorkingCommit extends CommitBase {
  wip: true
  changes: Change[]
}

export type Commit = GitCommit | WorkingCommit
export type PanelCommit = (Omit<GitCommit, 'date'> | Omit<WorkingCommit, 'date'>) & { dateLabel: string }

export interface GraphRow<T = Commit> {
  commit: T
  col: number
  hasIncoming: boolean
  before: (string | null)[]
  after: (string | null)[]
  joins: number[]
  forks: number[]
}

export type PanelRow = GraphRow<PanelCommit>

export interface LocalRef {
  name: string
  active: boolean
  remotes: string[]
}

export interface GroupedRefs {
  heads: LocalRef[]
  remotes: string[]
  tags: string[]
}

export interface PanelRefs {
  heads: (LocalRef & { color: string })[]
  remotes: { name: string; color: string }[]
  tags: { name: string; color: string }[]
}

export type UpstreamStatus =
  | { state: 'tracked'; name: string; ahead: number; behind: number }
  | { state: 'missing' | 'unavailable'; name: string }
  | { state: 'none' | 'detached' | 'unborn' }

export interface PanelData {
  repo: string
  repoPath?: string
  actionModule?: string
  branch: string
  head: string
  upstream?: UpstreamStatus
  rows: PanelRow[]
  refsByCommit: Record<string, PanelRefs>
  now: string
  error: string
  loading?: boolean
  unborn?: boolean
}

export interface RenderOptions {
  repo: string
  branch: string
  head: string
  upstream?: UpstreamStatus
  rows: GraphRow[]
  remotes?: string[]
  now?: Date | null
  error?: string
  loading?: boolean
  unborn?: boolean
}
