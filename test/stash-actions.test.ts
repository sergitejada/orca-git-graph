import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { stashCommand, type StashAction } from '../src/stash-actions.js'

for (const action of ['apply', 'pop', 'drop', 'branch'] as StashAction[]) {
  test(`stash ${action}: ejecuta Git sobre el hash elegido aunque cambie su índice`, async () => {
    const repo = await mkdtemp(join(tmpdir(), 'orca-stash-action-'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    try {
      git('init', '-b', 'main')
      git('config', 'user.name', 'Ana')
      git('config', 'user.email', 'ana@example.com')
      await writeFile(join(repo, 'file.txt'), 'base')
      git('add', '.')
      git('commit', '-m', 'base')
      await writeFile(join(repo, 'file.txt'), 'stash elegido')
      git('stash', 'push', '-m', 'elegido')
      const hash = git('rev-parse', 'refs/stash')
      const branch = "feature/ñ';$()"
      const command = stashCommand(repo, hash, action, branch)
      await writeFile(join(repo, 'file.txt'), 'stash nuevo')
      git('stash', 'push', '-m', 'nuevo')
      const latest = git('rev-parse', 'refs/stash')
      const script = Buffer.from(command.match(/Buffer.from\('([^']+)'/)![1], 'base64').toString('utf8')
      execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true })
      assert.equal(await readFile(join(repo, 'file.txt'), 'utf8'), action === 'drop' ? 'base' : 'stash elegido')
      const remaining = git('stash', 'list', '--format=%H').split('\n')
      assert.ok(remaining.includes(latest))
      assert.equal(remaining.includes(hash), action === 'apply')
      assert.equal(git('branch', '--show-current'), action === 'branch' ? branch : 'main')
    } finally { await rm(repo, { recursive: true, force: true }) }
  })
}

test('rechaza hashes, acciones y nombres vacíos inválidos antes de enviar comandos', () => {
  assert.throws(() => stashCommand('/repo', 'bad;command', 'drop'))
  assert.throws(() => stashCommand('/repo', 'a'.repeat(40), 'branch', ''))
})

test('pop conserva el stash cuando su aplicación provoca conflictos', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'orca-stash-conflict-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    git('init', '-b', 'main')
    git('config', 'user.name', 'Ana')
    git('config', 'user.email', 'ana@example.com')
    await writeFile(join(repo, 'file.txt'), 'base\n')
    git('add', '.')
    git('commit', '-m', 'base')
    await writeFile(join(repo, 'file.txt'), 'stash\n')
    git('stash', 'push', '-m', 'conflicto')
    const hash = git('rev-parse', 'refs/stash')
    await writeFile(join(repo, 'file.txt'), 'otro cambio\n')
    git('commit', '-am', 'otro cambio')
    const command = stashCommand(repo, hash, 'pop')
    const script = Buffer.from(command.match(/Buffer.from\('([^']+)'/)![1], 'base64').toString('utf8')
    assert.throws(() => execFileSync(process.execPath, ['-e', script], { windowsHide: true, stdio: 'pipe' }))
    assert.equal(git('rev-parse', 'refs/stash'), hash)
    assert.ok(git('status', '--porcelain').includes('UU file.txt'))
  } finally { await rm(repo, { recursive: true, force: true }) }
})
