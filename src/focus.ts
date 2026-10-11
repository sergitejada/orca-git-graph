import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

interface WorkspaceSession {
  activeRepoId?: string | null
  activeWorktreeId?: string | null
  activeWorkspaceKey?: string | null
  activeWorkspaceExecutionHostId?: string | null
}

export interface FocusState {
  workspaceSession?: WorkspaceSession
  repos?: { id: string; path: string; connectionId?: string | null }[]
  folderWorkspaces?: { id: string; path: string; executionHostId?: string }[]
}

// La API pública aún no expone la ruta enfocada. Solo leemos la selección y
// las rutas del perfil local; nunca escribimos en el estado de Orca.
export function focusedRepo(state: FocusState): string | null {
  const session = state.workspaceSession
  if (!session) throw new Error('Orca no tiene una sesión de workspace disponible')
  if (session.activeWorkspaceExecutionHostId && session.activeWorkspaceExecutionHostId !== 'local') return null
  const repo = state.repos?.find(repo => repo.id === session.activeRepoId)
  if (repo?.connectionId) return null
  const key = session.activeWorkspaceKey
  if (key?.startsWith('folder:')) {
    const folder = state.folderWorkspaces?.find(folder => folder.id === key.slice(7))
    return folder && (!folder.executionHostId || folder.executionHostId === 'local') ? folder.path : null
  }
  const worktreeId = key?.startsWith('worktree:') ? key.slice(9) : session.activeWorktreeId
  if (worktreeId) {
    const separator = worktreeId.indexOf('::')
    // Durante el cambio puede quedar un worktree del proyecto anterior.
    if (separator > 0 && (!session.activeRepoId || worktreeId.slice(0, separator) === session.activeRepoId)) {
      return worktreeId.slice(separator + 2) || null
    }
  }
  return repo?.path || null
}

export function orcaDataDirectory(): string {
  if (process.env.ORCA_USER_DATA_PATH) return process.env.ORCA_USER_DATA_PATH
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'orca')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'orca')
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'orca')
}

interface ProfileDatabase {
  prepare(sql: string): { all(): { domain: string; payload: string }[] }
  close(): void
}

export async function readActiveRepo(dataDirectory = orcaDataDirectory()): Promise<string | null> {
  let profileDirectory = dataDirectory
  const index = await readFile(join(dataDirectory, 'orca-profile-index.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (index !== null) {
    const { activeProfileId } = JSON.parse(index) as { activeProfileId?: unknown }
    if (typeof activeProfileId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(activeProfileId)) {
      throw new Error('El perfil activo de Orca no es válido')
    }
    profileDirectory = join(dataDirectory, 'profiles', activeProfileId)
  }
  const databasePath = join(profileDirectory, 'profile-state.db')
  const hasDatabase = await stat(databasePath).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  if (!hasDatabase) {
    return focusedRepo(JSON.parse(await readFile(join(profileDirectory, 'orca-data.json'), 'utf8')) as FocusState)
  }
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => ProfileDatabase
  }
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const state: Record<string, unknown> = {}
    // Una consulta toma una instantánea coherente de las tres proyecciones.
    for (const { domain, payload } of database.prepare(
      "SELECT domain, payload FROM profile_state_documents WHERE domain IN ('workspaceSession', 'repos', 'folderWorkspaces')",
    ).all()) state[domain] = JSON.parse(payload)
    return focusedRepo(state as FocusState)
  } finally {
    database.close()
  }
}
