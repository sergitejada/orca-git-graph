export interface Change {
  x: string
  y: string
  path: string
}

interface CommitBase {
  stash?: string
  hash: string
  parents: string[]
  refs: string[]
  subject: string
  author: string
  date: Date | null
  message?: string
  authorEmail?: string
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

export interface PanelData {
  repo: string
  repoPath?: string
  actionModule?: string
  branch: string
  head: string
  rows: PanelRow[]
  refsByCommit: Record<string, PanelRefs>
  now: string
  error: string
  loading?: boolean
  history?: HistoryInfo
}

export interface HistoryRequest {
  session: string
  limit: number
  target?: string
}

export interface HistoryInfo extends HistoryRequest {
  count: number
  incomplete: boolean
  capped: boolean
  focus?: string
  notice?: string
}

export interface RenderOptions {
  repo: string
  branch: string
  head: string
  rows: GraphRow[]
  remotes?: string[]
  now?: Date | null
  error?: string
  loading?: boolean
  history?: HistoryInfo
}
