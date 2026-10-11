import { fileURLToPath } from 'node:url'
import { resetPanel, writePanel } from './render.js'

export * from './render.js'

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === '--reset') {
    await resetPanel()
    console.log('panel.html vacío')
  } else {
    const repo = process.argv[2] ?? process.cwd()
    console.log(await writePanel(repo) ? `panel.html actualizado (${repo})` : 'sin cambios')
  }
}
