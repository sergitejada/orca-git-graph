import { build, type Plugin } from 'esbuild'
import { fileURLToPath } from 'node:url'

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

await build({
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
})
