import { build, type Plugin } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { writeFile, rename, rm } from 'node:fs/promises'
import { readActiveRepo } from './focus.js'
import { createRendererLoader } from './renderer-loader.js'

// Orca carga el HTML en srcdoc y su CSP permite solamente scripts y estilos inline.
const client = await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: ['src/client.tsx'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['es2020'],
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  supported: { 'inline-script': true },
  outfile: 'panel.js',
  write: false,
})

const script = client.outputFiles.find(file => file.path.endsWith('.js'))?.text
const styles = client.outputFiles.find(file => file.path.endsWith('.css'))?.text
if (!script || !styles) throw new Error('No se han generado los assets del panel')

const inlineAssets: Plugin = {
  name: 'inline-panel-assets',
  setup(builder) {
    builder.onResolve({ filter: /^panel-assets$/ }, () => ({ path: 'panel-assets', namespace: 'panel-assets' }))
    builder.onLoad({ filter: /.*/, namespace: 'panel-assets' }, () => ({
      contents: `export const script = ${JSON.stringify(script)}; export const styles = ${JSON.stringify(styles)};`,
      loader: 'js',
    }))
  },
}

const bundles = await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: { main: 'src/main.ts', render: 'src/render-cli.ts' },
  bundle: true,
  platform: 'node',
  target: ['node20'],
  format: 'esm',
  outdir: '.',
  outExtension: { '.js': '.mjs' },
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: { js: '// Generated from src/*.ts(x) by pnpm build. Edit the TypeScript sources.\nimport { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  plugins: [inlineAssets],
  write: false,
})

// Publica cada bundle completo: el worker nunca debe importar un archivo que
// esbuild todavía está escribiendo.
for (const output of bundles.outputFiles) {
  const temporary = `${output.path}.${process.pid}.tmp`
  try {
    await writeFile(temporary, output.contents)
    await rename(temporary, output.path)
  } finally { await rm(temporary, { force: true }) }
}

// Los tests compilan sin tocar el panel local ni leer el perfil del usuario.
if (process.argv.includes('--refresh-panel')) {
  try {
    const renderer = await createRendererLoader(new URL('../render.mjs', import.meta.url))()
    const repo = await readActiveRepo()
    if (repo) {
      await renderer.writePanel(repo, async () => await readActiveRepo() === repo)
    } else await renderer.resetPanel()
    console.log('Panel local actualizado con la compilación.')
  } catch (error) {
    console.warn(`Bundles compilados; no se pudo actualizar el panel local: ${error instanceof Error ? error.message : String(error)}`)
  }
}
