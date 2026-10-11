import assert from 'node:assert/strict'
import { test } from 'node:test'
import activate from '../main.mjs'

function worker() {
  let selected = '/projects/a'
  let tick
  let command
  let time = 10000
  let beforePublish = async () => {}
  const events = new Map()
  const published = []
  const errors = []
  activate({
    log: message => errors.push(message),
    commands: { register: (_id, handler) => { command = handler } },
    events: { on: (event, handler) => events.set(event, handler) },
  }, {
    readActiveRepo: async () => selected,
    writePanel: async (repo, isCurrent) => {
      await beforePublish(repo)
      if (!await isCurrent()) return false
      published.push(repo)
      return true
    },
    resetPanel: async () => { published.push(null) },
    now: () => time,
    setInterval: (handler, ms) => { assert.equal(ms, 1000); tick = handler },
  })
  return {
    published, errors, events,
    command: () => command(),
    ready: () => new Promise(resolve => setImmediate(resolve)),
    tick: async () => { tick(); await new Promise(resolve => setImmediate(resolve)) },
    select: repo => { selected = repo },
    advance: ms => { time += ms },
    beforePublish: handler => { beforePublish = handler },
  }
}

test('al arrancar y cambiar de proyecto sigue la selección sin actividad de agentes', async () => {
  const w = worker()
  await w.ready()
  assert.deepEqual(w.published, ['/projects/a'])
  w.select('/projects/b')
  await w.tick()
  assert.deepEqual(w.published, ['/projects/a', '/projects/b'])
  assert.deepEqual(await w.command(), { repo: '/projects/b' })
})

test('la actividad en segundo plano no selecciona su repositorio', async () => {
  const w = worker()
  await w.ready()
  await w.events.get('agent.status.changed')({ worktreeId: 'other::/projects/other' })
  await w.events.get('worktree.created')({ path: '/projects/other' })
  assert.ok(w.published.every(repo => repo === '/projects/a'))
})

test('comprueba el foco cada segundo pero Git se refresca cada cuatro segundos', async () => {
  const w = worker()
  await w.ready()
  w.advance(1000)
  await w.tick()
  assert.equal(w.published.length, 1)
  w.advance(3000)
  await w.tick()
  assert.equal(w.published.length, 2)
})

test('descarta el render anterior y procesa cambios rápidos mientras está ocupado', async () => {
  const w = worker()
  await w.ready()
  w.select('/projects/b')
  w.beforePublish(async repo => {
    if (repo === '/projects/b') {
      w.select('/projects/c')
      void w.events.get('agent.status.changed')({ worktreeId: 'other::/projects/other' })
    }
  })
  await w.command()
  assert.deepEqual(w.published, ['/projects/a', '/projects/c'])
})

test('sin selección limpia el grafo del proyecto anterior', async () => {
  const w = worker()
  await w.ready()
  w.select(null)
  await w.tick()
  assert.deepEqual(w.published, ['/projects/a', null])
  w.advance(4000)
  await w.tick()
  assert.deepEqual(w.published, ['/projects/a', null])
})

