import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { layout, renderHtml, wipCommit } from '../render.mjs'

// Reproduce el sandbox y la CSP de src/shared/plugins/plugin-panel-shell.ts de Orca.
const csp = "default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"
const commit = (hash, parents, refs = []) => ({ hash, parents, refs, subject: `commit ${hash}`, author: 'Ana', date: new Date(2026, 0, 1, 10, 0) })

test('refresh y fetch piden una terminal y validan las respuestas del bridge', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 600 } })
    page.setDefaultTimeout(5000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const html = renderHtml({ repo: '/repo', branch: 'main', head: 'a', rows: layout([commit('a', [])]) })
    await page.setContent('<iframe id="panel" sandbox="allow-scripts" style="border:0;width:100%;height:580px"></iframe>')
    await page.evaluate(() => {
      window.requests = []
      window.context = { terminals: [{ id: 'shell-1' }, { id: 'shell-2' }] }
      window.accepted = false
      window.addEventListener('message', event => {
        if (event.data?.type !== 'orca-panel-action') return
        window.requests.push(event.data)
        const value = event.data.action === 'workspace.readContext' ? window.context : { accepted: window.accepted }
        event.source.postMessage({ type: 'orca-panel-action-result', requestId: event.data.requestId, ok: true, value }, '*')
      })
    })
    await page.locator('#panel').evaluate((element, srcdoc) => { element.srcdoc = srcdoc }, `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head>${html}`)
    const frame = page.frameLocator('#panel')
    for (const [label, action] of [['Fetch from remote', 'fetch'], ['Refrescar grafo', 'refresh']]) {
      await frame.getByRole('button', { name: label, exact: true }).click()
      await frame.getByRole('dialog', { name: label, exact: true }).waitFor()
      await frame.getByLabel('Terminal de shell').waitFor()
      assert.equal(await frame.getByRole('button', { name: 'Ejecutar', exact: true }).isEnabled(), false)
      await frame.getByLabel('Terminal de shell').selectOption('shell-2')
      await frame.getByRole('button', { name: 'Ejecutar', exact: true }).click()
      await frame.getByRole('alert').getByText('La terminal no ha aceptado el comando.', { exact: true }).waitFor()
      await page.evaluate(() => { window.accepted = true })
      await frame.getByRole('button', { name: 'Ejecutar', exact: true }).click()
      await frame.getByText(/Comando enviado/).waitFor()
      assert.equal(await frame.getByRole('dialog').count(), 0)
      assert.equal(await frame.getByRole('button', { name: label, exact: true }).evaluate(element => element === document.activeElement), true)
      const request = await page.evaluate(() => window.requests.at(-1))
      assert.equal(request.action, 'terminal.sendText')
      assert.equal(request.params.terminalId, 'shell-2')
      assert.equal(request.params.enter, true)
      const script = Buffer.from(request.params.text.match(/Buffer.from\('([^']+)'/)[1], 'base64').toString('utf8')
      assert.ok(script.includes(`runRepositoryAction(${JSON.stringify(resolve('/repo'))}, ${JSON.stringify(action)})`))
      assert.equal(await frame.locator('body').evaluate(element => element.scrollWidth <= document.documentElement.clientWidth), true)
      await page.evaluate(() => { window.accepted = false })
    }
    await page.evaluate(() => { window.context = { terminals: [{ id: 123 }] } })
    await frame.getByRole('button', { name: 'Fetch from remote', exact: true }).click()
    await frame.getByRole('alert').getByText('Orca no ha devuelto una lista de terminales válida.', { exact: true }).waitFor()
    await frame.getByLabel('Terminal de shell').press('Escape')
    assert.equal(await frame.getByRole('dialog').count(), 0)
    await mkdir('test-artifacts', { recursive: true })
    await page.screenshot({ path: 'test-artifacts/header-actions.png' })
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})

test('los detalles inferiores se redimensionan con ratón y teclado en vistas anchas y estrechas', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    channel: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? undefined : (process.env.PLAYWRIGHT_BROWSER_CHANNEL || 'msedge'), headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 720 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    const history = Array.from({ length: 60 }, (_, index) => ({
      ...commit(`c${index}`, index < 59 ? [`c${index + 1}`] : []),
      message: Array.from({ length: 80 }, () => 'Mensaje completo del commit').join('\n'),
    }))
    const html = renderHtml({ repo: '/repo', branch: 'main', head: 'c0', rows: layout(history) })
    await page.setContent('<iframe id="panel" sandbox="allow-scripts" style="border:0;width:100%;height:700px"></iframe>')
    await page.locator('#panel').evaluate((element, srcdoc) => { element.srcdoc = srcdoc }, `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head>${html}`)
    const frame = page.frameLocator('#panel')
    await frame.getByRole('button', { name: 'Ir a HEAD' }).click()
    const separator = frame.getByRole('separator', { name: 'Ajustar altura de los detalles' })
    const graph = frame.locator('.graph-list')
    const details = frame.locator('.details')
    const graphBox = await graph.boundingBox()
    const detailsBox = await details.boundingBox()
    assert.ok(detailsBox.y >= graphBox.y + graphBox.height)
    assert.ok(Math.abs(detailsBox.width - graphBox.width) < 1)
    const handle = await separator.boundingBox()
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x + handle.width / 2, handle.y - 80, { steps: 5 })
    await page.mouse.up()
    assert.ok((await details.boundingBox()).height > detailsBox.height + 60)
    assert.equal(await frame.getByLabel('Hash completo').inputValue(), 'c0')
    await separator.press('Home')
    assert.equal(await separator.getAttribute('aria-valuenow'), '20')
    await separator.press('ArrowUp')
    assert.equal(await separator.getAttribute('aria-valuenow'), '25')
    await separator.press('End')
    await separator.press('ArrowUp')
    assert.equal(await separator.getAttribute('aria-valuenow'), '75')
    await separator.press('ArrowDown')
    assert.equal(await separator.getAttribute('aria-valuenow'), '70')
    await details.evaluate(element => { element.scrollTop = 150 })
    assert.equal(await graph.evaluate(element => element.scrollTop), 0)
    await graph.evaluate(element => { element.scrollTop = 240 })
    assert.equal(await details.evaluate(element => element.scrollTop), 150)
    await separator.press('Escape')
    assert.equal(await details.count(), 0)
    assert.equal(await frame.locator('tr[data-hash="c0"]').evaluate(element => element === document.activeElement), true)
    await frame.getByRole('button', { name: 'Ir a HEAD' }).click()
    assert.equal(await separator.getAttribute('aria-valuenow'), '70')
    await page.setViewportSize({ width: 360, height: 720 })
    const narrowGraph = await graph.boundingBox()
    const narrowDetails = await details.boundingBox()
    assert.ok(narrowDetails.y >= narrowGraph.y + narrowGraph.height)
    assert.equal(await frame.locator('body').evaluate(element => element.scrollWidth <= document.documentElement.clientWidth), true)
    await separator.press('Home')
    await page.setViewportSize({ width: 1100, height: 720 })
    await separator.press('ArrowUp')
    await separator.press('ArrowUp')
    await mkdir('test-artifacts', { recursive: true })
    await page.screenshot({ path: 'test-artifacts/commit-details-bottom.png' })
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})

test('los stashes muestran etiqueta, se buscan y abren detalles con navegación a su base', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(5000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const stash = { ...commit('s', ['a']), stash: 'stash@{0}', subject: 'On main: prueba' }
    const html = renderHtml({ repo: '/repo', branch: 'main', head: 'a', rows: layout([stash, commit('a', [], ['HEAD -> main'])]) })
    await page.setContent('<iframe id="panel" sandbox="allow-scripts" style="width:900px;height:600px"></iframe>')
    await page.locator('#panel').evaluate((element, srcdoc) => { element.srcdoc = srcdoc }, html)
    const frame = page.frameLocator('#panel')
    await frame.locator('.ref.stash').waitFor()
    assert.equal(await frame.locator('.ref.stash').innerText(), 'stash@{0}')
    await frame.locator('.ref.stash').click({ button: 'right' })
    await frame.getByRole('menu', { name: 'Acciones de stash@{0}' }).waitFor()
    assert.equal(await frame.locator('tr.selected').count(), 0)
    assert.equal(await frame.locator('.details').count(), 0)
    await frame.getByRole('menuitem').first().press('Escape')
    await frame.getByRole('button', { name: 'Acciones de stash@{0}', exact: true }).press('Shift+F10')
    await frame.getByRole('menu', { name: 'Acciones de stash@{0}' }).waitFor()
    await frame.getByRole('menuitem').first().press('Escape')
    await frame.locator('tr[data-hash="a"]').click()
    await frame.locator('.ref.stash').click({ button: 'right' })
    await frame.getByRole('menu', { name: 'Acciones de stash@{0}' }).waitFor()
    assert.equal(await frame.locator('tr.selected').getAttribute('data-hash'), 'a')
    assert.equal(await frame.getByLabel('Hash completo').inputValue(), 'a')
    await frame.getByRole('menuitem').first().press('Escape')
    await frame.getByRole('button', { name: 'Abrir búsqueda' }).click()
    await frame.getByLabel('Buscar commits').fill('stash@{0}')
    await frame.getByRole('status').getByText('1 coincidencias · contexto visible').waitFor()
    await frame.locator('tr[data-hash="s"]').click()
    assert.equal(await frame.getByRole('menu').count(), 0)
    await frame.locator('.ref.stash').click()
    assert.equal(await frame.getByRole('menu').count(), 0)
    await frame.locator('tr[data-hash="s"] .subject').click({ button: 'right' })
    assert.equal(await frame.getByRole('menu').count(), 0)
    await frame.locator('tr[data-hash="s"]').press('Enter')
    assert.equal(await frame.getByRole('menu').count(), 0)
    await frame.locator('.ref.stash .name').click({ button: 'right' })
    await frame.getByRole('menu', { name: 'Acciones de stash@{0}' }).waitFor()
    assert.deepEqual(await frame.getByRole('menuitem').allTextContents(), ['Apply Stash…', 'Create Branch from Stash…', 'Pop Stash…', 'Drop Stash…', 'Copy Stash Name to Clipboard', 'Copy Stash Hash to Clipboard'])
    await frame.getByRole('menuitem').first().press('Escape')
    await frame.getByRole('heading', { name: 'Stash stash@{0}', exact: true }).waitFor()
    await frame.getByRole('button', { name: 'a', exact: true }).click()
    assert.equal(await frame.locator('tr[data-hash="a"]').getAttribute('aria-selected'), 'true')
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})

test('el menú pide una terminal explícita y envía el stash elegido por el bridge de Orca', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(5000)
    const hash = 'a'.repeat(40)
    const stash = { ...commit(hash, ['b']), stash: 'stash@{0}' }
    const html = renderHtml({ repo: '/repo', branch: 'main', head: 'b', rows: layout([stash, commit('b', [])]) })
    await page.setContent('<iframe id="panel" sandbox="allow-scripts" style="width:900px;height:600px"></iframe>')
    await page.evaluate(() => {
      window.requests = []
      window.addEventListener('message', event => {
        if (event.data?.type !== 'orca-panel-action') return
        window.requests.push(event.data)
        const value = event.data.action === 'workspace.readContext' ? { terminals: [{ id: 'shell-1' }, { id: 'shell-2' }] } : { accepted: true }
        event.source.postMessage({ type: 'orca-panel-action-result', requestId: event.data.requestId, ok: true, value }, '*')
      })
    })
    await page.locator('#panel').evaluate((element, srcdoc) => { element.srcdoc = srcdoc }, `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head>${html}`)
    const frame = page.frameLocator('#panel')
    await frame.locator('.ref.stash .ico').click({ button: 'right' })
    await frame.getByRole('menuitem', { name: 'Create Branch from Stash…', exact: true }).click()
    await frame.locator('.stash-dialog input:focus').waitFor()
    await frame.getByLabel('Nueva rama').fill('feature/stash')
    await frame.getByLabel('Terminal de shell').selectOption('shell-2')
    await frame.getByRole('button', { name: 'Ejecutar', exact: true }).click()
    await frame.getByText(/Comando enviado/).waitFor()
    const requests = await page.evaluate(() => window.requests)
    assert.equal(requests.length, 2)
    assert.equal(requests[1].action, 'terminal.sendText')
    assert.equal(requests[1].params.terminalId, 'shell-2')
    assert.equal(requests[1].params.enter, true)
    const script = Buffer.from(requests[1].params.text.match(/Buffer.from\('([^']+)'/)[1], 'base64').toString('utf8')
    assert.ok(script.includes(hash))
    assert.ok(script.includes('feature/stash'))
    assert.ok(script.includes('"branch"'))
    assert.equal(await frame.getByRole('dialog').count(), 0)
    await frame.locator('body').evaluate(body => {
      body.ownerDocument.execCommand = command => {
        if (command !== 'copy') return false
        const input = body.ownerDocument.querySelector('textarea')
        body.dataset.copied = input.value
        return true
      }
    })
    for (const [label, value] of [['Copy Stash Name to Clipboard', 'stash@{0}'], ['Copy Stash Hash to Clipboard', hash]]) {
      await frame.locator('.ref.stash').click({ button: 'right' })
      await frame.getByRole('menuitem', { name: label, exact: true }).click()
      await frame.getByText(/(?:Nombre|Hash) del stash copiado/).waitFor()
      assert.equal(await frame.locator('body').getAttribute('data-copied'), value)
    }
  } finally { await browser.close() }
})

test('la carga inicial se hidrata en el sandbox y da paso al historial o al error', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    channel: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? undefined : (process.env.PLAYWRIGHT_BROWSER_CHANNEL || 'msedge'), headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 480 }, reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.setContent('<iframe id="panel" sandbox="allow-scripts" style="border:0;width:100%;height:450px"></iframe>')
    const show = html => page.locator('#panel').evaluate((element, srcdoc) => { element.srcdoc = srcdoc }, `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head>${html}`)
    const frame = page.frameLocator('#panel')
    await show(renderHtml({ repo: '/repo', branch: '', head: '', rows: [], loading: true }))
    await frame.getByRole('status').getByText('Cargando Git Graph…', { exact: true }).waitFor()
    assert.equal(await frame.locator('main').getAttribute('aria-busy'), 'true')
    assert.equal(await frame.locator('header, table, .hint').count(), 0)
    assert.equal(await frame.locator('.loading-spinner').evaluate(element => getComputedStyle(element).animationName), 'none')
    assert.equal(await frame.locator('body').evaluate(element => element.scrollWidth <= document.documentElement.clientWidth), true)
    await mkdir('test-artifacts', { recursive: true })
    await page.screenshot({ path: 'test-artifacts/loading-view.png' })
    await show(renderHtml({ repo: '/repo', branch: 'main', head: 'a', rows: layout([commit('a', [])]) }))
    await frame.getByRole('table', { name: 'Historial de commits' }).waitFor()
    assert.equal(await frame.locator('.loading-view').count(), 0)
    await show(renderHtml({ repo: '/repo', branch: '', head: '', rows: [], error: 'No se pudo leer el repositorio' }))
    await frame.getByText('No se pudo leer el repositorio', { exact: true }).waitFor()
    assert.equal(await frame.locator('.loading-view').count(), 0)
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})

test('React se hidrata y mantiene estilos en el iframe aislado de Orca', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    channel: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? undefined : (process.env.PLAYWRIGHT_BROWSER_CHANNEL || 'msedge'),
    headless: true,
  })
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 360 } })
    const errors = []
    const requests = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('request', request => requests.push(request.url()))
    const history = [
      wipCommit([{ x: ' ', y: 'M', path: 'src/panel.tsx' }], 'a'),
      commit('a', ['b', 'f'], ['HEAD -> main', 'origin/main']),
      { ...commit('f', ['b'], ['feature']), subject: '</script><img src=x onerror=alert(1)>' },
      commit('b', []),
    ]
    const html = renderHtml({ repo: '/repo', branch: 'main', head: 'a', rows: layout(history), remotes: ['origin'], now: new Date(2026, 0, 1, 10, 0) })
    await page.setContent('<iframe id="panel" sandbox="allow-scripts" style="border:0;width:100%;height:340px"></iframe>')
    await page.locator('#panel').evaluate((element, srcdoc) => { element.srcdoc = srcdoc }, `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head>${html}`)
    const frame = page.frameLocator('#panel')
    await frame.locator('tbody tr').first().waitFor()
    assert.equal(await frame.locator('tbody tr').count(), 4)
    assert.equal(await frame.locator('body').evaluate(element => getComputedStyle(element).fontSize), '13px')
    assert.equal(await frame.locator('body').evaluate(element => getComputedStyle(element).color), 'rgb(204, 204, 204)')
    assert.equal(await frame.locator('.ref svg').first().evaluate(element => element.getBoundingClientRect().height), 12)
    assert.equal(await frame.locator('tbody tr').first().evaluate(element => element.getBoundingClientRect().height), 24)
    assert.equal(await frame.locator('img').count(), 0)

    // El selector está disponible sin abrir Filtros; incluye las ramas remotas.
    await frame.getByLabel('Filtrar por rama').click()
    await frame.getByRole('listbox').getByRole('option', { name: 'origin/main', exact: true }).waitFor()
    assert.equal(await frame.getByLabel('Buscar ramas').evaluate(element => element === document.activeElement), true)
    await frame.getByLabel('Buscar ramas').fill('ninguna-rama')
    await frame.getByText('No hay ramas que coincidan.', { exact: true }).waitFor()
    assert.equal(await frame.getByRole('listbox').getByRole('option').count(), 1)
    await frame.getByLabel('Buscar ramas').press('Escape')
    assert.equal(await frame.getByRole('listbox').count(), 0)
    assert.equal(await frame.getByLabel('Filtrar por rama').evaluate(element => element === document.activeElement), true)
    await frame.getByLabel('Filtrar por rama').press('ArrowDown')
    await frame.getByLabel('Buscar ramas').fill('FEAT')
    await frame.getByLabel('Buscar ramas').press('ArrowDown')
    await frame.getByLabel('Buscar ramas').press('Enter')
    await frame.getByText('2 coincidencias · contexto visible', { exact: true }).waitFor()
    await frame.getByLabel('Filtrar por rama').click()
    assert.equal(await frame.getByRole('listbox').getByRole('option', { name: 'feature', exact: true }).getAttribute('aria-selected'), 'true')
    await frame.getByRole('option', { name: 'Todas las ramas', exact: true }).click()

    // Un click que cambia estado demuestra que se cargó React, además del HTML del servidor.
    await frame.getByRole('button', { name: 'Filtros', exact: true }).click()
    await frame.getByLabel('Filtrar por rama').waitFor()
    await page.setViewportSize({ width: 360, height: 360 })
    assert.equal(await frame.locator('th.author').isVisible(), false)
    await frame.getByLabel('Filtrar por rama').click()
    assert.equal(await frame.locator('body').evaluate(element => element.scrollWidth <= document.documentElement.clientWidth), true)
    await mkdir('test-artifacts', { recursive: true })
    await page.screenshot({ path: 'test-artifacts/branch-selector.png' })
    await frame.getByLabel('Buscar ramas').press('Escape')
    await page.setViewportSize({ width: 900, height: 360 })
    assert.equal(await frame.locator('th.author').isVisible(), true)
    assert.deepEqual(errors, [])
    assert.deepEqual(requests, [])
    await mkdir('test-artifacts', { recursive: true })
    await page.screenshot({ path: 'test-artifacts/panel-react-ts.png' })
  } finally {
    await browser.close()
  }
})

test('búsqueda, filtros, detalles y navegación funcionan sin romper el grafo', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    channel: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? undefined : (process.env.PLAYWRIGHT_BROWSER_CHANNEL || 'msedge'), headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1050, height: 720 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    const history = [
      wipCommit([{ x: ' ', y: 'M', path: 'src/panel.tsx' }, { x: '?', y: '?', path: 'src/details.tsx' }], 'a'),
      { ...commit('a', ['b', 'f'], ['HEAD -> main', 'origin/main']), subject: 'Merge feature', message: 'Merge feature\n\nAñade navegación por teclado y detalles.', authorEmail: 'ana@example.com' },
      { ...commit('f', ['b'], ['feature']), subject: 'Añadir explorador de commits', author: 'Bob', authorEmail: 'bob@example.com' },
      { ...commit('b', []), subject: 'Crear Git Graph' },
    ]
    const html = renderHtml({ repo: '/git-graph', branch: 'main', head: 'a', rows: layout(history), remotes: ['origin'], now: new Date(2026, 0, 1, 10, 0) })
    await page.setContent('<iframe id="panel" sandbox="allow-scripts" style="border:0;width:100%;height:700px"></iframe>')
    await page.locator('#panel').evaluate((element, srcdoc) => { element.srcdoc = srcdoc }, `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head>${html}`)
    const frame = page.frameLocator('#panel')
    assert.equal(await frame.getByLabel('Buscar commits').count(), 0)
    await frame.getByRole('button', { name: 'Abrir búsqueda' }).click()
    assert.equal(await frame.getByLabel('Buscar commits').evaluate(element => element === document.activeElement), true)
    await frame.getByLabel('Buscar commits').fill('Bob')
    await frame.getByText('1 coincidencias · contexto visible', { exact: true }).waitFor()
    assert.equal(await frame.locator('tbody tr').count(), 4)
    assert.equal(await frame.locator('tbody tr.dimmed').count(), 3)
    await frame.getByRole('button', { name: 'Cerrar búsqueda' }).click()
    assert.equal(await frame.getByLabel('Buscar commits').count(), 0)
    assert.equal(await frame.getByRole('button', { name: 'Abrir búsqueda' }).evaluate(element => element === document.activeElement), true)
    assert.equal(await frame.locator('tbody tr.dimmed').count(), 0)
    await frame.getByRole('button', { name: 'Abrir búsqueda' }).press('/')
    await frame.getByLabel('Buscar commits').fill('Bob')
    await frame.getByRole('button', { name: 'Coincidencia siguiente' }).click()
    await frame.getByRole('complementary', { name: 'Detalles del commit' }).getByRole('heading', { name: 'Añadir explorador de commits', exact: true }).waitFor()
    assert.equal(await frame.locator('tr.selected').getAttribute('data-hash'), 'f')

    await frame.getByRole('button', { name: 'Limpiar', exact: true }).click()
    await frame.getByRole('button', { name: 'Filtros', exact: true }).click()
    await frame.getByLabel('Filtrar por rama').click()
    await frame.getByLabel('Buscar ramas').fill('FEAT')
    assert.equal(await frame.getByRole('listbox').getByRole('option').count(), 2)
    await frame.getByRole('option', { name: 'feature', exact: true }).click()
    await frame.getByText('2 coincidencias · contexto visible', { exact: true }).waitFor()
    await frame.getByLabel('Filtrar por autor').selectOption('Bob')
    await frame.getByText('1 coincidencias · contexto visible', { exact: true }).waitFor()
    await frame.getByLabel('Solo merges').check()
    await frame.getByText('Sin coincidencias. Cambia la búsqueda o limpia los filtros.').waitFor()
    assert.equal(await frame.getByRole('button', { name: 'Coincidencia siguiente' }).isEnabled(), false)
    await frame.getByRole('button', { name: 'Limpiar', exact: true }).click()
    await frame.getByRole('button', { name: 'Ir a HEAD' }).click()
    assert.equal(await frame.getByLabel('Hash completo').inputValue(), 'a')
    assert.match(await frame.locator('.commit-message').textContent(), /Añade navegación por teclado y detalles/)
    await frame.getByRole('button', { name: 'Copiar hash' }).click()
    await frame.locator('.copy-message').filter({ hasText: /Hash copiado|Hash seleccionado/ }).waitFor()
    await frame.getByRole('button', { name: 'f', exact: true }).click()
    assert.equal(await frame.locator('tr.selected').getAttribute('data-hash'), 'f')
    await frame.locator('tr[data-hash="WORKING_TREE"]').click()
    await frame.locator('.changes-list').getByText('src/details.tsx', { exact: true }).waitFor()
    await frame.locator('tr.selected').press('ArrowDown')
    assert.equal(await frame.locator('tr.selected').getAttribute('data-hash'), 'a')
    await frame.locator('tr.selected').press('/')
    assert.equal(await frame.getByLabel('Buscar commits').evaluate(element => element === document.activeElement), true)
    await frame.getByLabel('Buscar commits').press('Escape')
    assert.equal(await frame.locator('.details').count(), 0)

    await frame.getByRole('button', { name: 'Ir a HEAD' }).click()
    await frame.locator('tr[data-hash="a"].selected').waitFor()
    await frame.getByRole('complementary', { name: 'Detalles del commit' }).waitFor()
    await mkdir('test-artifacts', { recursive: true })
    await page.screenshot({ path: 'test-artifacts/git-graph-explorer.png' })
    await page.setViewportSize({ width: 360, height: 720 })
    assert.equal(await frame.locator('body').evaluate(element => element.scrollWidth <= document.documentElement.clientWidth), true)
    await frame.locator('html').evaluate(element => { element.style.setProperty('--background', '#fff'); element.style.setProperty('--foreground', '#222') })
    assert.equal(await frame.locator('body').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(23, 23, 23)')
    assert.equal(await frame.locator('th').first().evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(23, 23, 23)')
    assert.equal(await frame.locator('.graph circle').first().evaluate(element => getComputedStyle(element).fill), 'rgb(23, 23, 23)')
    assert.equal(await frame.getByLabel('Buscar commits').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)')
    assert.equal(await frame.getByLabel('Buscar commits').evaluate(element => getComputedStyle(element).color), 'rgb(34, 34, 34)')
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})
