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
  const loading = []
  const operations = []
  const timers = []
  const renders = []
  let inFlight = 0
  let maxInFlight = 0
  const historySelections = []
  activate({
    log: message => errors.push(message),
    commands: { register: (_id, handler) => { command = handler } },
    events: { on: (event, handler) => events.set(event, handler) },
  }, {
    readActiveRepo: async () => { operations.push('read'); return selected },
    prepareHistory: async repo => { historySelections.push(repo) },
    writeLoadingPanel: async repo => { loading.push(repo ?? ''); operations.push('loading') },
    writePanel: async (repo, isCurrent, force) => {
      renders.push({ repo, force })
      maxInFlight = Math.max(maxInFlight, ++inFlight)
      try {
        await beforePublish(repo)
        if (!await isCurrent()) return false
        published.push(repo)
        return true
      } finally { inFlight-- }
    },
    resetPanel: async () => { published.push(null) },
    now: () => time,
    setInterval: (handler, ms) => { assert.equal(ms, 1000); tick = handler },
    setTimeout: (handler, ms) => { assert.equal(ms, 250); timers.push(handler) },
  })
  return {
    published, errors, events, loading, operations, renders, historySelections,
    maxInFlight: () => maxInFlight,
    flushEvents: async () => { timers.splice(0).forEach(handler => { handler() }); await new Promise(resolve => setImmediate(resolve)) },
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

test('muestra la carga antes de leer el foco y mientras Git sigue pendiente', async () => {
  const w = worker()
  let finish
  const gate = new Promise(resolve => { finish = resolve })
  w.beforePublish(() => gate)
  await w.ready()
  assert.deepEqual(w.operations.slice(0, 2), ['loading', 'read'])
  assert.deepEqual(w.loading, [''])
  assert.deepEqual(w.published, [])
  finish()
  await w.ready()
  assert.deepEqual(w.published, ['/projects/a'])
  w.advance(4000)
  await w.tick()
  assert.deepEqual(w.loading, [''], 'los refrescos del mismo repo no muestran carga')
  w.select('/projects/b')
  await w.tick()
  assert.deepEqual(w.loading, ['', '/projects/b'])
  w.select(null)
  await w.tick()
  assert.equal(w.published.at(-1), null)
  assert.deepEqual(w.loading, ['', '/projects/b'])
})

test('un fallo inesperado durante la carga limpia el indicador y permite reintentar', async () => {
  const w = worker()
  w.beforePublish(async () => { throw new Error('fallo de lectura') })
  await w.ready()
  assert.deepEqual(w.published, [null])
  assert.ok(w.errors.some(message => message.includes('fallo de lectura')))
  w.beforePublish(async () => {})
  await w.tick()
  assert.equal(w.published.at(-1), '/projects/a')
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

test('agrupa ráfagas sin forzar la caché y el comando manual sí la fuerza', async () => {
  const w = worker()
  await w.ready()
  for (let i = 0; i < 100; i++) {
    await w.events.get(i % 2 ? 'agent.status.changed' : 'worktree.created')()
  }
  assert.equal(w.renders.length, 1)
  await w.flushEvents()
  assert.deepEqual(w.renders.map(render => render.force), [true, false])
  await w.command()
  assert.deepEqual(w.renders.map(render => render.force), [true, false, true])
  w.advance(4000)
  await w.tick()
  assert.equal(w.renders.at(-1).force, false)
})

test('serializa Git y conserva un único refresco pendiente durante ráfagas', async () => {
  const w = worker()
  await w.ready()
  let finish
  const gate = new Promise(resolve => { finish = resolve })
  let first = true
  w.beforePublish(() => { if (first) { first = false; return gate } })
  w.advance(4000)
  await w.tick()
  for (let batch = 0; batch < 3; batch++) {
    for (let i = 0; i < 20; i++) await w.events.get('agent.status.changed')()
    await w.flushEvents()
  }
  assert.equal(w.renders.length, 2)
  finish()
  await w.ready()
  assert.equal(w.renders.length, 3)
  assert.equal(w.maxInFlight(), 1)
})

test('lee selección durante un render lento y publica solo la última selección', async () => {
  const w = worker()
  await w.ready()
  let finish
  const gate = new Promise(resolve => { finish = resolve })
  w.beforePublish(repo => repo === '/projects/a' ? gate : Promise.resolve())
  w.advance(4000)
  await w.tick()
  const reads = w.operations.filter(operation => operation === 'read').length
  w.select('/projects/b')
  await w.tick()
  assert.ok(w.operations.filter(operation => operation === 'read').length > reads)
  w.select('/projects/c')
  for (let i = 0; i < 30; i++) await w.events.get('worktree.created')()
  await w.flushEvents()
  finish()
  await w.ready()
  assert.deepEqual(w.published, ['/projects/a', '/projects/c'])
  assert.equal(w.maxInFlight(), 1)
  assert.equal(w.renders.at(-1).force, true)
})



test('reinicia el rango solo al cambiar la selección y conserva la sesión en refrescos concurrentes', async () => {
  const w = worker()
  await w.ready()
  assert.deepEqual(w.historySelections, ['/projects/a'])
  await Promise.all([w.command(), w.events.get('agent.status.changed')()])
  assert.deepEqual(w.historySelections, ['/projects/a'])
  w.select('/projects/b')
  await w.command()
  w.select('/projects/a')
  await w.command()
  assert.deepEqual(w.historySelections, ['/projects/a', '/projects/b', '/projects/a'])
})
