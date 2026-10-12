import { readActiveRepo } from './focus.js'
import { resetPanel, writeLoadingPanel, writePanel } from './render.js'

interface Orca {
  log(message: string): void
  commands: {
    register(id: string, handler: () => Promise<{ repo: string | null }>): void
  }
  events: {
    on(event: 'agent.status.changed' | 'worktree.created', handler: () => Promise<unknown>): void
  }
}

const POLL_MS = 1000
const GRAPH_REFRESH_MS = 4000

export interface WorkerDependencies {
  readActiveRepo: () => Promise<string | null>
  writePanel: (repo: string, isCurrent: () => Promise<boolean>) => Promise<boolean>
  resetPanel: () => Promise<void>
  writeLoadingPanel: (repo?: string) => Promise<void>
  now: () => number
  setInterval: (handler: () => void, ms: number) => unknown
}

export default function activate(orca: Orca, dependencies: WorkerDependencies = {
  readActiveRepo, writePanel, resetPanel, writeLoadingPanel, now: Date.now, setInterval,
}): void {
  let repo: string | null | undefined
  let lastRefresh = 0
  let running: Promise<void> | null = null
  let pending = false
  let forceRefresh = false

  const refresh = (force = false): Promise<void> => {
    pending = true
    forceRefresh ||= force
    if (running) return running
    running = (async () => {
      while (pending) {
        pending = false
        const forced = forceRefresh
        forceRefresh = false
        const initial = repo === undefined
        let loading = false
        try {
          if (initial) {
            await dependencies.writeLoadingPanel()
            loading = true
          }
          const selected = await dependencies.readActiveRepo()
          const selectionChanged = selected !== repo
          if (!selectionChanged && !forced && dependencies.now() - lastRefresh < GRAPH_REFRESH_MS) continue
          repo = selected
          if (selected === null) {
            if (selectionChanged) await dependencies.resetPanel()
          } else {
            if (selectionChanged && !initial) {
              await dependencies.writeLoadingPanel(selected)
              loading = true
            }
            const changed = await dependencies.writePanel(selected, async () => {
              if (await dependencies.readActiveRepo() === selected) return true
              pending = true
              return false
            })
            if (changed) orca.log(`grafo actualizado: ${selected}`)
          }
          lastRefresh = dependencies.now()
        } catch (error) {
          orca.log(`error al generar el grafo: ${error instanceof Error ? error.message : String(error)}`)
          if (loading) {
            repo = undefined
            await dependencies.resetPanel().catch(error => orca.log(`error al limpiar el panel: ${String(error)}`))
          }
        }
      }
    })().finally(() => { running = null })
    return running
  }

  orca.commands.register('git-graph-refresh', async () => {
    await refresh(true)
    return { repo: repo ?? null }
  })
  // La actividad de otros proyectos solo dispara una lectura del foco actual.
  orca.events.on('agent.status.changed', () => refresh(true))
  orca.events.on('worktree.created', () => refresh(true))
  dependencies.setInterval(() => { void refresh() }, POLL_MS)
  void refresh(true)
}
