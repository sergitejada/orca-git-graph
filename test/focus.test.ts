import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { focusedRepo, readActiveRepo } from '../src/focus.js'

test('resuelve el worktree seleccionado y el repositorio principal sin worktree', () => {
  const repos = [{ id: 'a', path: 'C:/projects/a' }, { id: 'b', path: 'C:/projects/b' }]
  assert.equal(focusedRepo({ repos, workspaceSession: { activeRepoId: 'a', activeWorktreeId: 'a::C:/worktrees/task' } }), 'C:/worktrees/task')
  assert.equal(focusedRepo({ repos, workspaceSession: { activeRepoId: 'b' } }), 'C:/projects/b')
  assert.equal(focusedRepo({ repos, workspaceSession: { activeRepoId: 'b', activeWorktreeId: 'a::C:/worktrees/task' } }), 'C:/projects/b')
  assert.equal(focusedRepo({ repos, workspaceSession: { activeRepoId: null, activeWorktreeId: null } }), null)
})

test('la clave de workspace tiene prioridad y no interpreta una ruta remota como local', () => {
  assert.equal(focusedRepo({ workspaceSession: {
    activeWorkspaceKey: 'worktree:b::/worktrees/b', activeWorktreeId: 'a::/worktrees/a',
  } }), '/worktrees/b')
  assert.equal(focusedRepo({ workspaceSession: {
    activeWorktreeId: 'a::/remote/project', activeWorkspaceExecutionHostId: 'ssh:server',
  } }), null)
  assert.equal(focusedRepo({ repos: [{ id: 'a', path: '/remote/project', connectionId: 'server' }],
    workspaceSession: { activeRepoId: 'a', activeWorktreeId: 'a::/remote/project' },
  }), null)
})

test('lee el perfil seleccionado en SQLite sin recurrir al JSON obsoleto', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-git-graph-focus-'))
  const profile = join(directory, 'profiles', 'personal')
  await mkdir(profile, { recursive: true })
  await writeFile(join(directory, 'orca-profile-index.json'), JSON.stringify({ activeProfileId: 'personal' }))
  await writeFile(join(profile, 'orca-data.json'), JSON.stringify({ workspaceSession: { activeWorktreeId: 'old::/old' } }))
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  const database = new DatabaseSync(join(profile, 'profile-state.db'))
  try {
    database.exec('CREATE TABLE profile_state_documents (domain TEXT PRIMARY KEY, payload TEXT)')
    const insert = database.prepare('INSERT INTO profile_state_documents VALUES (?, ?)')
    insert.run('workspaceSession', JSON.stringify({ activeRepoId: 'a', activeWorktreeId: 'a::/selected' }))
    insert.run('repos', JSON.stringify([{ id: 'a', path: '/project' }]))
    assert.equal(await readActiveRepo(directory), '/selected')
    database.prepare('UPDATE profile_state_documents SET payload = ? WHERE domain = ?')
      .run(JSON.stringify({ activeRepoId: 'a', activeWorktreeId: 'a::/next' }), 'workspaceSession')
    assert.equal(await readActiveRepo(directory), '/next')
    await writeFile(join(profile, 'profile-state.db.snapshot'), await readFile(join(profile, 'profile-state.db')))
    await readActiveRepo(directory)
    assert.deepEqual(await readFile(join(profile, 'profile-state.db')), await readFile(join(profile, 'profile-state.db.snapshot')))
  } finally { database.close() }
})

test('admite perfiles antiguos en JSON y rechaza perfiles inválidos', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-git-graph-focus-'))
  await writeFile(join(directory, 'orca-data.json'), JSON.stringify({ workspaceSession: { activeWorktreeId: 'a::/legacy' } }))
  assert.equal(await readActiveRepo(directory), '/legacy')
  await writeFile(join(directory, 'orca-profile-index.json'), JSON.stringify({ activeProfileId: '../other' }))
  await assert.rejects(readActiveRepo(directory), /perfil activo/)
})
