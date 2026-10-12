import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readActiveRepo } from './focus.js'
import { writePanel } from './render.js'

const run = promisify(execFile)

interface ActionDependencies {
  readActiveRepo(): Promise<string | null>
  fetch(repo: string): Promise<void>
  writePanel(repo: string, isCurrent: () => Promise<boolean>): Promise<boolean>
}

export async function runRepositoryAction(repo: string, action: 'refresh' | 'fetch', dependencies: ActionDependencies = {
  readActiveRepo,
  fetch: async repo => {
    const { stdout, stderr } = await run('git', ['fetch', '--all'], { cwd: repo, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
    if (stdout) console.log(stdout.trimEnd())
    if (stderr) console.log(stderr.trimEnd())
  },
  writePanel,
}): Promise<void> {
  if (!repo || !['refresh', 'fetch'].includes(action)) throw new Error('Acción o repositorio inválido.')
  const isCurrent = async () => await dependencies.readActiveRepo() === repo
  if (!await isCurrent()) throw new Error('El repositorio seleccionado ha cambiado. Vuelve a abrir la acción.')
  if (action === 'fetch') await dependencies.fetch(repo)
  await dependencies.writePanel(repo, isCurrent)
}
