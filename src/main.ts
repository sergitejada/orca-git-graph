import { readActiveRepo } from './focus.js'
import { createRendererLoader } from './renderer-loader.js'

const loadRenderer = createRendererLoader(new URL('./render.mjs', import.meta.url))

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
const EVENT_BATCH_MS = 250

export interface WorkerDependencies {
  readActiveRepo: () => Promise<string | null>
  writePanel: (repo: string, isCurrent: () => Promise<boolean>, force: boolean) => Promise<boolean>
  resetPanel: () => Promise<void>
  writeLoadingPanel: (repo?: string) => Promise<void>
  prepareHistory?: (repo: string) => Promise<void>
  now: () => number
  setInterval: (handler: () => void, ms: number) => unknown
  setTimeout: (handler: () => void, ms: number) => unknown
}

export default function activate(orca: Orca, dependencies: WorkerDependencies = {
  readActiveRepo,
  writePanel: async (repo, isCurrent, force) => {
    const renderer = await loadRenderer()
    return renderer.writePanel(repo, async () => await loadRenderer() === renderer && await isCurrent(), true, force)
  },
  resetPanel: async () => (await loadRenderer()).resetPanel(),
  writeLoadingPanel: async repo => (await loadRenderer()).writeLoadingPanel(repo),
  prepareHistory: async repo => { await (await loadRenderer()).resetHistory(repo) },
  now: Date.now, setInterval, setTimeout,
}): void {
  let repo: string | null | undefined
  let lastRefresh = 0
  let running: Promise<void> | null = null
  let pending = false
  let forceRefresh = false
  let activityRefresh = false
  let eventScheduled = false

  const refresh = (force = false, activity = false): Promise<void> => {
    pending = true
    forceRefresh ||= force
    activityRefresh ||= activity
    if (running) return running
    running = (async () => {
      while (pending) {
        pending = false
        const forced = forceRefresh
        forceRefresh = false
        const active = activityRefresh
        activityRefresh = false
        const initial = repo === undefined
        let loading = false
        try {
          if (initial) {
            await dependencies.writeLoadingPanel()
            loading = true
          }
          const selected = await dependencies.readActiveRepo()
          const selectionChanged = selected !== repo
          if (!selectionChanged && !forced && !active && dependencies.now() - lastRefresh < GRAPH_REFRESH_MS) continue
          repo = selected
          if (selected === null) {
            if (selectionChanged) await dependencies.resetPanel()
          } else {
            if (selectionChanged) await dependencies.prepareHistory?.(selected)
            if (selectionChanged && !initial) {
              await dependencies.writeLoadingPanel(selected)
              loading = true
            }
            const changed = await dependencies.writePanel(selected, async () => {
              if (await dependencies.readActiveRepo() === selected) return true
              pending = true
              return false
            }, forced || selectionChanged)
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
  const onActivity = async () => {
    if (eventScheduled) return
    eventScheduled = true
    // Ventana fija, no debounce deslizante: una ráfaga continua no retrasa Git.
    dependencies.setTimeout(() => {
      eventScheduled = false
      void refresh(false, true)
    }, EVENT_BATCH_MS)
  }
  orca.events.on('agent.status.changed', onActivity)
  orca.events.on('worktree.created', onActivity)
  dependencies.setInterval(() => {
    if (running) {
      // Detecta selección incluso durante un Git lento. El render pendiente
      // comprueba de nuevo el foco antes de publicar.
      void dependencies.readActiveRepo().then(selected => {
        if (selected !== repo) void refresh()
      }).catch(error => orca.log(`error al leer la selección: ${String(error)}`))
    } else void refresh()
  }, POLL_MS)
  void refresh(true)
}
