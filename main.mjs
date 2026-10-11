// Worker del plugin: Node sin Electron, arrancado por Orca al primer evento
// o comando. Regenera panel.html con el grafo del último worktree activo;
// Orca recarga el panel cuando el fichero cambia.
import { writePanel } from './render.mjs'

const POLL_MS = 4000

export default function activate(orca) {
  let repo = null
  let running = false

  const refresh = async () => {
    if (!repo || running) return
    running = true
    try {
      if (await writePanel(repo)) orca.log(`grafo actualizado: ${repo}`)
    } catch (e) {
      orca.log(`error al generar el grafo: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      running = false
    }
  }

  const useRepo = async path => {
    if (!path || path === repo) return refresh()
    repo = path
    await orca.host.call('storage.set', { key: 'repo', value: repo })
    return refresh()
  }

  // worktreeId tiene la forma "<repoId>::<ruta>"
  const pathOf = worktreeId => {
    const i = worktreeId?.lastIndexOf('::') ?? -1
    return i >= 0 ? worktreeId.slice(i + 2) : null
  }

  orca.host
    .call('storage.get', { key: 'repo' })
    .then(stored => {
      if (!repo && typeof stored?.value === 'string') {
        repo = stored.value
        void refresh()
      }
    })
    .catch(() => {})

  orca.commands.register('git-graph-refresh', async () => {
    await refresh()
    return { repo }
  })

  orca.events.on('agent.status.changed', payload => useRepo(pathOf(payload.worktreeId)))
  orca.events.on('worktree.created', payload => useRepo(payload.path))

  setInterval(refresh, POLL_MS)
}
