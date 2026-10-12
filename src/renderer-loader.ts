import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

type Renderer = Pick<typeof import('./render.js'), 'writePanel' | 'resetPanel' | 'writeLoadingPanel' | 'resetHistory'>

// Node cachea imports por URL. La revisión del contenido permite cargar el
// renderizador recién compilado sin reiniciar el worker ni crear otro timer.
export function createRendererLoader(url: URL): () => Promise<Renderer> {
  let revision = ''
  let renderer: Promise<Renderer> | null = null
  return async () => {
    const next = createHash('sha256').update(await readFile(url)).digest('hex')
    if (!renderer || revision !== next) {
      const versioned = new URL(url)
      versioned.searchParams.set('revision', next)
      revision = next
      renderer = import(versioned.href) as Promise<Renderer>
      const current = renderer
      void current.catch(() => { if (renderer === current) renderer = null })
    }
    return renderer
  }
}
