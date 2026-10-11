import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { layout, renderHtml, wipCommit } from '../render.mjs'

// Reproduce el sandbox y la CSP de src/shared/plugins/plugin-panel-shell.ts de Orca.
const csp = "default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"
const commit = (hash, parents, refs = []) => ({ hash, parents, refs, subject: `commit ${hash}`, author: 'Ana', date: new Date(2026, 0, 1, 10, 0) })

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
    await frame.getByLabel('Buscar commits').fill('Bob')
    await frame.getByText('1 coincidencias · contexto visible', { exact: true }).waitFor()
    assert.equal(await frame.locator('tbody tr').count(), 4)
    assert.equal(await frame.locator('tbody tr.dimmed').count(), 3)
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
    assert.equal(await frame.locator('circle').first().evaluate(element => getComputedStyle(element).fill), 'rgb(23, 23, 23)')
    assert.equal(await frame.getByLabel('Buscar commits').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)')
    assert.equal(await frame.getByLabel('Buscar commits').evaluate(element => getComputedStyle(element).color), 'rgb(34, 34, 34)')
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})
