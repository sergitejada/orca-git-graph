import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import type { CommitComparison, CommitFile, GitCommit } from './types.js'

export const DIFF_LIMITS = { output: 64 * 1024, files: 100, patch: 16 * 1024, lines: 600, parents: 4, comparisons: 300, payload: 4 * 1024 * 1024, loadMs: 15000 }
const cache = new Map<string, Promise<CommitComparison>>()
const HASH = /^[a-f0-9]{40,64}$/

// Both stdout and stderr are bounded. Stop Git rather than collecting an
// unlimited patch in memory. No shell, external diff drivers or textconv.
async function readGit(repo: string, args: string[]): Promise<{ output: string; limited: boolean }> {
  return new Promise((accept, reject) => {
    const child = spawn('git', ['--no-pager', ...args], { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let bytes = 0
    let limited = false
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 5000)
    child.stdout.on('data', (chunk: Buffer) => {
      const remaining = DIFF_LIMITS.output - bytes
      if (remaining > 0) { chunks.push(chunk.subarray(0, remaining)); bytes += Math.min(chunk.length, remaining) }
      if (chunk.length > remaining) { limited = true; child.kill() }
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(0, 2000) })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      if (timedOut) reject(new Error('Git superó el límite de 5 segundos para esta comparación.'))
      else if (code !== 0 && !limited) reject(new Error(stderr || 'No se pudo leer la comparación.'))
      else accept({ output: Buffer.concat(chunks).toString('utf8'), limited })
    })
  })
}

// -z keeps tabs, newlines, quotes and pathspec-looking names literal.
export function parseDiffFiles(raw: string): CommitFile[] {
  const entries = raw.split('\0')
  const files: CommitFile[] = []
  for (let i = 0; i < entries.length - 1; i++) {
    const match = /^:\d{6} \d{6} [a-f0-9]+ [a-f0-9]+ ([A-Z][0-9]*)$/.exec(entries[i])
    if (!match) break
    const status = match[1]
    const oldPath = entries[++i]
    const renamed = status.startsWith('R') || status.startsWith('C')
    const path = renamed ? entries[++i] : oldPath
    if (path === undefined || i >= entries.length - 1) break
    files.push({ path, ...(renamed ? { oldPath } : {}), status, patch: '', binary: false })
  }
  return files
}

async function readComparison(repo: string, base: string | null, target: string): Promise<CommitComparison> {
  if (!HASH.test(target) || (base !== null && !HASH.test(base))) throw new Error('Hash de comparación inválido.')
  const command = base ? ['diff', base, target] : ['diff-tree', '--root', '--no-commit-id', '-r', target]
  const flags = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-abbrev', '--find-renames', '-l100', '--submodule=short']
  const raw = await readGit(repo, [...command, ...flags, '--raw', '-z', '--'])
  const allFiles = parseDiffFiles(raw.output)
  const files = allFiles.slice(0, DIFF_LIMITS.files)
  const result: CommitComparison = { label: '', base, target, files }
  if (raw.limited || allFiles.length > files.length) result.notice = 'Lista recortada: máximo 100 archivos y 64 KiB de metadatos.'
  if (!files.length) return result
  let patch: { output: string; limited: boolean }
  try { patch = await readGit(repo, [...command, ...flags, '--patch', '--unified=3', '--']) } catch (error) {
    result.notice = [result.notice, error instanceof Error ? error.message : String(error)].filter(Boolean).join(' ')
    files.forEach(file => { file.notice = 'No se pudo cargar el diff de esta comparación.' })
    return result
  }
  const patches = patch.output.split(/(?=^diff --git )/m).filter(Boolean)
  files.forEach((file, index) => {
    const text = patches[index]
    if (!text) { file.notice = 'Diff no incluido: límite de 64 KiB por comparación.'; return }
    file.binary = /^Binary files .* differ$/m.test(text) || /^GIT binary patch$/m.test(text)
    const lines = text.split('\n')
    const encoded = Buffer.from(lines.slice(0, DIFF_LIMITS.lines).join('\n'))
    file.patch = new TextDecoder('utf-8', { ignoreBOM: true }).decode(encoded.subarray(0, DIFF_LIMITS.patch), { stream: true })
    if (lines.length > DIFF_LIMITS.lines || encoded.length > DIFF_LIMITS.patch || (patch.limited && index === patches.length - 1)) {
      file.notice = 'Diff recortado: máximo 16 KiB / 600 líneas por archivo y 64 KiB por comparación.'
    }
  })
  if (patch.limited) result.notice = [result.notice, 'Diff de la comparación recortado a 64 KiB.'].filter(Boolean).join(' ')
  return result
}

function cachedComparison(repo: string, base: string | null, target: string): Promise<CommitComparison> {
  const key = JSON.stringify([resolve(repo), base, target])
  const found = cache.get(key)
  if (found) return found
  const pending = readComparison(repo, base, target).catch(error => ({ label: '', base, target, files: [], notice: error instanceof Error ? error.message : String(error) }))
  cache.set(key, pending)
  // Immutable comparisons, including failures, are reused on the 4s refresh.
  // Bound the cache across repository selection changes as well.
  if (cache.size > 1024) cache.delete(cache.keys().next().value as string)
  return pending
}

export async function loadCommitDiffs(repo: string, commits: GitCommit[]): Promise<void> {
  let count = 0
  let bytes = 0
  const deadline = Date.now() + DIFF_LIMITS.loadMs
  for (const commit of commits) {
    delete commit.diffNotice
    const parents = commit.stashParents || commit.parents
    const requests: { base: string | null; target: string; label: string }[] = commit.stash
      ? [{ base: parents[0] ?? null, target: commit.hash, label: 'Stash: cambios de trabajo respecto a la base' },
        ...(parents[1] ? [{ base: parents[0] ?? null, target: parents[1], label: 'Stash: índice respecto a la base' }] : []),
        ...(parents[2] ? [{ base: null, target: parents[2], label: 'Stash: archivos sin seguimiento' }] : [])]
      : parents.length ? parents.slice(0, DIFF_LIMITS.parents).map((base, index) => ({ base, target: commit.hash, label: `Padre ${index + 1}: ${base.slice(0, 8)}` }))
        : [{ base: null, target: commit.hash, label: 'Commit raíz: comparación con árbol vacío' }]
    commit.comparisons = []
    if (!commit.stash && parents.length > DIFF_LIMITS.parents) commit.diffNotice = 'Solo se incluyen los primeros 4 padres del merge.'
    for (const request of requests) {
      if (count >= DIFF_LIMITS.comparisons || bytes >= DIFF_LIMITS.payload) {
        commit.diffNotice = 'Comparación no precargada: límite del panel de 300 comparaciones / 4 MiB. El bridge público de Orca no permite pedir diffs al worker.'
        break
      }
      if (Date.now() >= deadline) {
        commit.diffNotice = 'Comparación pendiente: se agotó el presupuesto de carga de 15 segundos. Se continuará en el siguiente refresco reutilizando la caché.'
        break
      }
      count++
      const comparison = { ...await cachedComparison(repo, request.base, request.target), label: request.label }
      const size = Buffer.byteLength(JSON.stringify(comparison))
      if (bytes + size > DIFF_LIMITS.payload) { bytes = DIFF_LIMITS.payload; commit.diffNotice = 'Comparación no precargada: límite de 4 MiB del panel.'; break }
      bytes += size
      commit.comparisons.push(comparison)
    }
  }
}
