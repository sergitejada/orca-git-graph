import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { buildPanel, layout, renderHtml, wipCommit } from '../render.mjs'

// Reproduce el sandbox y la CSP de src/shared/plugins/plugin-panel-shell.ts de Orca.
const csp = "default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"
const commit = (hash, parents, refs = []) => ({ hash, parents, refs, subject: `commit ${hash}`, author: 'Ana', date: new Date(2026, 0, 1, 10, 0) })

test('upstream se hidrata con etiquetas accesibles y sin desbordamiento en sidebar estrecha', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 280, height: 480 } })
    page.setDefaultTimeout(5000)
    const errors = []
    const requests = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('request', request => requests.push(request.url()))
    await page.setContent('<iframe id="panel" sandbox="allow-scripts" style="border:0;width:100%;height:450px"></iframe>')
    const frame = page.frameLocator('#panel')
    const show = upstream => page.locator('#panel').evaluate((element, html) => { element.srcdoc = html }, `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head>${renderHtml({ repo: '/repo', branch: 'feature/very-long-branch-name'.repeat(4), head: 'a', rows: layout([commit('a', [])]), upstream })}`)
    const name = 'origin/release/very-long-upstream-name'.repeat(5)
    await show({ state: 'tracked', name, ahead: 12, behind: 3 })
    await frame.getByRole('region', { name: 'Relación con upstream' }).waitFor()
    await frame.getByLabel('12 commits por delante (ahead)').waitFor()
    await frame.getByLabel('3 commits por detrás (behind)').waitFor()
    assert.equal(await frame.locator('.upstream-name b').textContent(), name)
    await frame.getByRole('button', { name: 'Abrir búsqueda' }).click()
    await frame.getByLabel('Buscar commits').waitFor()
    assert.equal(await frame.locator('body').evaluate(element => element.scrollWidth <= document.documentElement.clientWidth), true)
    await mkdir('test-artifacts', { recursive: true })
    await page.screenshot({ path: 'test-artifacts/upstream-narrow.png' })
    for (const [status, message] of [
      [{ state: 'tracked', name, ahead: 0, behind: 0 }, '0 ahead'],
      [{ state: 'none' }, 'Sin upstream'],
      [{ state: 'missing', name }, 'Upstream no disponible en refs locales'],
      [{ state: 'detached' }, 'HEAD separado: sin rama actual'],
      [{ state: 'unborn' }, 'Sin commits'],
      [{ state: 'unavailable', name }, 'Comparación no disponible'],
    ]) {
      await show(status)
      if (status.state === 'tracked') await frame.getByLabel('0 commits por delante (ahead)').waitFor()
      else await frame.getByText(message, { exact: true }).waitFor()
    }
    assert.deepEqual(errors, [])
    assert.deepEqual(requests, [])
  } finally { await browser.close() }
})

test('Git real: la vista sin commits se hidrata y pasa al primer commit sin conexiones inventadas', { timeout: 30000 }, async () => {
  const repo = await mkdtemp(join(tmpdir(), 'orca-unborn-browser-'))
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()
  try {
    git('init', '-b', 'first/branch')
    git('config', 'user.name', 'Ana')
    git('config', 'user.email', 'ana@example.com')
    const page = await browser.newPage({ viewport: { width: 360, height: 720 } })
    page.setDefaultTimeout(5000)
    const errors = []
    const requests = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('request', request => requests.push(request.url()))
    await page.setContent('<iframe id="panel" sandbox="allow-scripts" style="border:0;width:100%;height:700px"></iframe>')
    const show = async () => page.locator('#panel').evaluate((element, srcdoc) => { element.srcdoc = srcdoc }, `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head>${await buildPanel(repo)}`)
    const frame = page.frameLocator('#panel')
    await show()
    await frame.getByRole('status').getByText(/No hay archivos pendientes del primer commit/).waitFor()
    assert.equal(await frame.locator('header b').nth(1).textContent(), 'first/branch')
    assert.equal(await frame.locator('table, .error, .graph').count(), 0)

    await writeFile(join(repo, 'staged.txt'), 'first\n')
    git('add', '--', 'staged.txt')
    await writeFile(join(repo, 'pending.txt'), 'pending\n')
    await show()
    await frame.getByRole('status').getByText('Archivos pendientes del primer commit.', { exact: false }).waitFor()
    assert.equal(await frame.locator('tbody tr').count(), 1)
    assert.equal(await frame.locator('.graph path').count(), 0)
    assert.equal(await frame.locator('.graph circle').count(), 1)
    assert.equal(await frame.getByRole('button', { name: 'Ir a HEAD' }).isDisabled(), true)
    await frame.locator('tr[data-hash="WORKING_TREE"]').press('Enter')
    await frame.locator('.changes-list').getByText('staged.txt', { exact: true }).waitFor()
    await frame.locator('.changes-list').getByText('pending.txt', { exact: true }).waitFor()
    await frame.getByRole('button', { name: 'Abrir búsqueda' }).click()
    await frame.getByLabel('Buscar commits').fill('pending.txt')
    assert.equal(await frame.locator('tr.wip.dimmed').count(), 0)
    assert.equal(await frame.locator('body').evaluate(element => element.scrollWidth <= document.documentElement.clientWidth), true)
    await mkdir('test-artifacts', { recursive: true })
    await page.screenshot({ path: 'test-artifacts/unborn-repository.png' })

    git('-c', 'commit.gpgsign=false', 'commit', '-m', 'First commit')
    await show()
    await frame.getByText('First commit', { exact: true }).waitFor()
    assert.equal(await frame.getByText(/todavía no tiene commits/).count(), 0)
    assert.equal(await frame.locator('tbody tr').count(), 2)
    assert.equal(await frame.locator('.graph path').count(), 2)
    await frame.getByRole('button', { name: 'Ir a HEAD' }).click()
    assert.equal(await frame.getByLabel('Hash completo').inputValue(), git('rev-parse', 'HEAD'))
    assert.deepEqual(errors, [])
    assert.deepEqual(requests, [])
  } finally {
    await browser.close()
    await rm(repo, { recursive: true, force: true })
  }
})

test('restaura una instantánea validada después de reemplazar el iframe opaco, sin almacenamiento ni bridge', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 720 } })
    page.setDefaultTimeout(5000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.setContent('<main id="host"></main>')
    await page.evaluate(() => {
      window.panelRequests = []
      window.addEventListener('message', event => { if (event.data?.type === 'orca-panel-action') window.panelRequests.push(event.data.action) })
    })
    const history = Array.from({ length: 65 }, (_, index) => ({
      ...commit(`c${index}`, index === 64 ? [] : [`c${index + 1}`], index === 0 ? ['HEAD -> main', 'origin/main'] : []),
      message: `commit c${index}\n${'Long commit message\n'.repeat(100)}`,
    }))
    history.unshift({ ...commit('stash', ['c0']), stash: 'stash@{0}' }, commit('remote', ['c0'], ['origin/topic']))
    const show = async (repo, commits = history) => {
      const html = renderHtml({ repo, branch: 'main', head: 'c0', remotes: ['origin'], rows: layout(commits) })
      // Orca keys the iframe by document revision: replace the element, not
      // just its srcdoc. window.name and history cannot cross this boundary.
      await page.locator('#host').evaluate((host, srcdoc) => {
        const iframe = document.createElement('iframe')
        iframe.id = 'panel'
        iframe.name = 'orca-plugin-panel:git-graph:graph'
        iframe.setAttribute('sandbox', 'allow-scripts')
        iframe.style.cssText = 'border:0;width:100%;height:700px'
        iframe.srcdoc = srcdoc
        host.replaceChildren(iframe)
      }, `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head>${html}`)
      await page.frameLocator('#panel').getByRole('button', { name: 'Estado del panel', exact: true }).waitFor()
    }
    await show('/repo')
    const frame = page.frameLocator('#panel')
    assert.equal(await frame.locator('body').evaluate(() => {
      try { localStorage.setItem('state', 'x'); return 'available' } catch (error) { return error.name }
    }), 'SecurityError')
    await frame.getByRole('button', { name: 'Opciones del grafo', exact: true }).click()
    await frame.getByRole('menuitemcheckbox', { name: 'Mostrar ramas remotas' }).click()
    await frame.getByRole('menuitemcheckbox', { name: 'Mostrar stashes' }).click()
    await frame.getByRole('menuitemcheckbox', { name: 'Mostrar stashes' }).press('Escape')
    await frame.getByLabel('Filtrar por rama').click()
    await frame.getByRole('option', { name: 'main', exact: true }).click()
    await frame.getByRole('button', { name: 'Abrir búsqueda', exact: true }).click()
    await frame.getByRole('searchbox', { name: 'Buscar commits' }).fill('commit')
    await frame.getByRole('button', { name: 'Filtros', exact: true }).click()
    await frame.getByLabel('Filtrar por autor').selectOption('Ana')
    await frame.getByRole('checkbox', { name: 'Solo merges' }).check()
    await frame.locator('tr[data-hash="c40"]').click()
    await frame.getByRole('separator').press('End')
    await frame.locator('tr[data-hash="c40"]').focus()
    await frame.locator('.graph-list').evaluate(element => { element.scrollTop = 450 })
    await frame.locator('.details').evaluate(element => { element.scrollTop = 160 })
    await frame.getByRole('button', { name: 'Estado del panel', exact: true }).click()
    const snapshot = await frame.getByLabel('Instantánea del panel').inputValue()
    const saved = JSON.parse(snapshot)
    assert.deepEqual(saved.scroll, { graph: 450, details: 160 })
    assert.deepEqual(saved.focus, { kind: 'row', value: 'c40' })
    assert.equal(saved.detailsHeight, 75)
    await frame.getByRole('button', { name: 'Cerrar', exact: true }).press('Escape')
    assert.equal(await frame.getByRole('dialog').count(), 0)
    // Closing the state dialog does not trigger the panel's Escape shortcut.
    assert.equal(await frame.locator('tr[aria-selected="true"]').getAttribute('data-hash'), 'c40')
    await show('/repo')
    assert.equal(await frame.locator('.details').count(), 0)
    assert.equal(await frame.getByRole('searchbox', { name: 'Buscar commits' }).count(), 0)
    assert.equal(await frame.locator('tbody tr').count(), history.length)
    const restore = async text => {
      await frame.getByRole('button', { name: 'Estado del panel', exact: true }).click()
      await frame.getByLabel('Instantánea del panel').fill(text)
      await frame.getByRole('button', { name: 'Restaurar', exact: true }).click()
    }
    await restore(snapshot)
    await frame.getByRole('dialog').waitFor({ state: 'detached' })
    assert.equal(await frame.getByRole('searchbox', { name: 'Buscar commits' }).inputValue(), 'commit')
    assert.equal(await frame.getByLabel('Filtrar por autor').inputValue(), 'Ana')
    assert.equal(await frame.getByRole('checkbox', { name: 'Solo merges' }).isChecked(), true)
    assert.match(await frame.getByLabel('Filtrar por rama').innerText(), /main/)
    assert.equal(await frame.locator('tbody tr').count(), 65)
    assert.equal(await frame.locator('tr[aria-selected="true"]').getAttribute('data-hash'), 'c40')
    assert.equal(await frame.getByRole('separator').getAttribute('aria-valuenow'), '75')
    assert.equal(await frame.locator('tr[data-hash="c40"]').evaluate(element => element === document.activeElement), true)
    assert.equal(await frame.locator('.graph-list').evaluate(element => element.scrollTop), 450)
    assert.equal(await frame.locator('.details').evaluate(element => element.scrollTop), 160)
    // Exact repo paths isolate identical repository names.
    await show('/other/repo')
    await restore(snapshot)
    await frame.getByRole('status').filter({ hasText: 'otro repositorio o worktree' }).waitFor()
    assert.equal(await frame.locator('.details').count(), 0)
    await frame.getByLabel('Instantánea del panel').fill('{broken')
    await frame.getByRole('button', { name: 'Restaurar', exact: true }).click()
    await frame.getByRole('status').filter({ hasText: 'JSON válido' }).waitFor()
    assert.equal(await frame.locator('.details').count(), 0)
    // Block clipboard APIs to exercise the explicit manual-copy fallback.
    await frame.locator('body').evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { value: undefined })
      document.execCommand = () => false
    })
    await frame.getByRole('button', { name: 'Copiar actual', exact: true }).click()
    await frame.getByRole('status').filter({ hasText: 'Pulsa Ctrl+C' }).waitFor()
    const copySelection = await frame.getByLabel('Instantánea del panel').evaluate(element => ({ selected: element.selectionEnd - element.selectionStart, length: element.value.length, path: JSON.parse(element.value).repoPath }))
    assert.equal(copySelection.selected, copySelection.length)
    assert.equal(copySelection.path, JSON.parse(await frame.locator('#git-graph-data').textContent()).repoPath)
    await show('/repo', history.filter(entry => entry.hash !== 'c40'))
    await restore(snapshot)
    await frame.getByRole('dialog').waitFor({ state: 'detached' })
    assert.equal(await frame.locator('.details').count(), 0)
    assert.equal(await frame.locator('tr[data-hash="c0"]').evaluate(element => element === document.activeElement), true)
    assert.equal(await frame.getByRole('searchbox', { name: 'Buscar commits' }).inputValue(), 'commit')
    // Restore a control focus and uncommitted view option too.
    await show('/repo', [wipCommit([{ x: ' ', y: 'M', path: 'file.ts' }], 'c0'), ...history])
    const working = { ...saved, filters: { ...saved.filters, query: '<img src=x onerror=alert(1)>' }, selectedHash: 'WORKING_TREE', focusHash: 'WORKING_TREE', focus: { kind: 'control', value: 'Buscar commits' }, changesView: 'list', scroll: { graph: 0, details: 0 } }
    await restore(JSON.stringify(working))
    await frame.getByRole('dialog').waitFor({ state: 'detached' })
    assert.equal(await frame.getByRole('button', { name: 'Ver como lista' }).getAttribute('aria-pressed'), 'true')
    assert.equal(await frame.getByRole('searchbox', { name: 'Buscar commits' }).evaluate(element => element === document.activeElement), true)
    assert.equal(await frame.getByRole('searchbox', { name: 'Buscar commits' }).inputValue(), working.filters.query)
    assert.equal(await frame.locator('img').count(), 0)
    await page.setViewportSize({ width: 200, height: 720 })
    await frame.getByRole('button', { name: 'Estado del panel', exact: true }).click()
    assert.equal(await frame.getByRole('dialog').evaluate(element => element.scrollWidth <= element.clientWidth), true)
    assert.deepEqual(await page.evaluate(() => window.panelRequests), [])
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})

test('los cambios sin confirmar muestran iconos y colores y alternan entre árbol y lista', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 720 } })
    page.setDefaultTimeout(5000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    const changes = [
      { x: ' ', y: 'M', path: 'src/panel.tsx' },
      { x: 'A', y: ' ', path: 'src/nested/new.ts' },
      { x: '?', y: '?', path: 'src/nested/<new & file>.ts' },
      { x: 'D', y: ' ', path: 'removed.ts' },
      { x: 'R', y: 'M', path: 'renamed.ts' },
      { x: 'U', y: 'U', path: 'conflict.ts' },
      { x: 'A', y: 'A', path: 'both-added.ts' },
      { x: 'D', y: 'D', path: 'both-deleted.ts' },
    ]
    const html = renderHtml({ repo: '/repo', branch: 'main', head: 'a', rows: layout([wipCommit(changes, 'a'), commit('a', [])]) })
    await page.setContent('<iframe id="panel" sandbox="allow-scripts" style="border:0;width:100%;height:700px"></iframe>')
    await page.locator('#panel').evaluate((element, srcdoc) => { element.srcdoc = srcdoc }, `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head>${html}`)
    const frame = page.frameLocator('#panel')
    await frame.locator('tr[data-hash="WORKING_TREE"]').click()
    assert.equal(await frame.getByRole('button', { name: 'Ver como árbol' }).getAttribute('aria-pressed'), 'true')
    assert.equal(await frame.locator('.change-file .change-icon').count(), changes.length)
    assert.equal(await frame.locator('.changes-list code').count(), 0)
    assert.equal(await frame.locator('.changes-list').getByText('panel.tsx', { exact: true }).count(), 1)
    const expected = [
      ['src/panel.tsx', 'Modificado', 'modified', 'rgb(255, 204, 128)'],
      ['src/nested/new.ts', 'Añadido', 'added', 'rgb(129, 199, 132)'],
      ['src/nested/<new & file>.ts', 'Sin seguimiento', 'untracked', 'rgb(129, 199, 132)'],
      ['removed.ts', 'Eliminado', 'deleted', 'rgb(229, 115, 115)'],
      ['renamed.ts', 'Renombrado', 'renamed', 'rgb(128, 203, 196)'],
      ['conflict.ts', 'Conflicto', 'conflict', 'rgb(239, 154, 154)'],
      ['both-added.ts', 'Conflicto', 'conflict', 'rgb(239, 154, 154)'],
      ['both-deleted.ts', 'Conflicto', 'conflict', 'rgb(239, 154, 154)'],
    ]
    for (const [path, state, kind, color] of expected) {
      const file = frame.getByTitle(`${path} · ${state}`, { exact: true })
      assert.equal(await file.getAttribute('title'), `${path} · ${state}`)
      assert.equal(await file.locator(`.change-${kind}`).evaluate(element => getComputedStyle(element).color), color)
    }
    const folder = frame.locator('summary').filter({ hasText: /^src$/ })
    await folder.focus()
    await folder.press('Enter')
    assert.equal(await frame.getByText('panel.tsx', { exact: true }).isVisible(), false)
    await folder.press('Enter')
    await frame.getByRole('button', { name: 'Ver como lista' }).focus()
    await frame.getByRole('button', { name: 'Ver como lista' }).press('Enter')
    assert.equal(await frame.locator('.changes-list summary').count(), 0)
    assert.equal(await frame.getByText('src/nested/<new & file>.ts', { exact: true }).isVisible(), true)
    assert.equal(await frame.getByRole('button', { name: 'Ver como lista' }).getAttribute('aria-pressed'), 'true')
    await frame.getByRole('button', { name: 'Ver como árbol' }).click()
    await frame.getByRole('separator', { name: 'Ajustar altura de los detalles' }).press('End')
    assert.equal(await frame.locator('body').evaluate(element => element.scrollWidth <= document.documentElement.clientWidth), true)
    await mkdir('test-artifacts', { recursive: true })
    await page.screenshot({ path: 'test-artifacts/uncommitted-changes-tree.png' })
    await frame.locator('tr[data-hash="a"]').click()
    assert.equal(await frame.getByRole('group', { name: 'Vista de los cambios sin confirmar' }).count(), 0)
    await frame.getByLabel('Hash completo').waitFor()
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})

test('las opciones del grafo ocultan remotas y stashes y funcionan con teclado en la sidebar estrecha', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 600 } })
    page.setDefaultTimeout(5000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    const history = [{ ...commit('s', ['b']), stash: 'stash@{0}' }, commit('r', ['b'], ['origin/topic']), commit('a', ['b'], ['HEAD -> main', 'origin/main']), commit('b', [])]
    const html = renderHtml({ repo: '/repo', branch: 'main', head: 'a', remotes: ['origin'], rows: layout(history) })
    await page.setContent('<iframe id="panel" sandbox="allow-scripts" style="border:0;width:100%;height:580px"></iframe>')
    await page.locator('#panel').evaluate((element, srcdoc) => { element.srcdoc = srcdoc }, `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head>${html}`)
    const frame = page.frameLocator('#panel')
    const options = frame.getByRole('button', { name: 'Opciones del grafo', exact: true })
    await frame.getByLabel('Filtrar por rama').click()
    await frame.getByRole('option', { name: 'origin/topic', exact: true }).click()
    await options.press('ArrowDown')
    const remote = frame.getByRole('menuitemcheckbox', { name: 'Mostrar ramas remotas', exact: true })
    const stashes = frame.getByRole('menuitemcheckbox', { name: 'Mostrar stashes', exact: true })
    await remote.waitFor()
    assert.equal(await remote.getAttribute('aria-checked'), 'true')
    assert.equal(await stashes.getAttribute('aria-checked'), 'true')
    assert.equal(await remote.evaluate(element => element === document.activeElement), true)
    await remote.press('Enter')
    await frame.locator('tr[data-hash="r"]').waitFor({ state: 'detached' })
    assert.equal(await frame.locator('tbody tr').count(), 3)
    assert.equal(await frame.locator('.ref .remote').count(), 0)
    assert.equal(await frame.getByLabel('Filtrar por rama').innerText(), 'Todas las ramas\n▾')
    await remote.press('ArrowDown')
    assert.equal(await stashes.evaluate(element => element === document.activeElement), true)
    await stashes.press('Escape')
    assert.equal(await frame.getByRole('menu', { name: 'Opciones del grafo' }).count(), 0)
    assert.equal(await options.evaluate(element => element === document.activeElement), true)
    await frame.getByLabel('Filtrar por rama').click()
    assert.deepEqual(await frame.getByRole('option').allTextContents(), ['✓Todas las ramas', 'main'])
    await frame.getByLabel('Buscar ramas').press('Escape')
    await frame.locator('tr[data-hash="s"]').click()
    await frame.getByRole('heading', { name: 'Stash stash@{0}', exact: true }).waitFor()
    await options.click()
    await stashes.click()
    await frame.locator('tr[data-hash="s"]').waitFor({ state: 'detached' })
    assert.equal(await frame.locator('.details').count(), 0)
    assert.equal(await frame.locator('tbody tr').count(), 2)
    assert.equal(await remote.getAttribute('aria-checked'), 'false')
    assert.equal(await stashes.getAttribute('aria-checked'), 'false')
    await remote.click()
    await frame.locator('tr[data-hash="r"]').waitFor()
    await stashes.click()
    await frame.locator('tr[data-hash="s"]').waitFor()
    assert.equal(await frame.locator('tbody tr').count(), 4)
    await remote.press('Escape')
    await page.setViewportSize({ width: 200, height: 600 })
    await options.click()
    const rect = await frame.getByRole('menu', { name: 'Opciones del grafo' }).boundingBox()
    assert.ok(rect.x >= 0 && rect.x + rect.width <= 200)
    assert.equal(await frame.locator('body').evaluate(element => element.scrollWidth <= document.documentElement.clientWidth), true)
    await mkdir('test-artifacts', { recursive: true })
    await page.screenshot({ path: 'test-artifacts/view-options.png' })
    await frame.locator('header .label').first().click()
    assert.equal(await frame.getByRole('menu', { name: 'Opciones del grafo' }).count(), 0)
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})

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
    await frame.locator('tr[data-hash="a"].dimmed').waitFor()
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
    await frame.locator('tr[data-hash="a"].dimmed').waitFor()
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
    await frame.locator('tbody tr.dimmed').nth(2).waitFor()
    assert.equal(await frame.locator('.results-bar').count(), 0)
    assert.equal(await frame.getByRole('button', { name: 'Coincidencia anterior' }).count(), 0)
    assert.equal(await frame.getByRole('button', { name: 'Coincidencia siguiente' }).count(), 0)
    assert.equal(await frame.locator('tbody tr').count(), 4)
    assert.equal(await frame.locator('tbody tr.dimmed').count(), 3)
    await frame.getByRole('button', { name: 'Cerrar búsqueda' }).click()
    assert.equal(await frame.getByLabel('Buscar commits').count(), 0)
    assert.equal(await frame.getByRole('button', { name: 'Abrir búsqueda' }).evaluate(element => element === document.activeElement), true)
    assert.equal(await frame.locator('tbody tr.dimmed').count(), 0)
    await frame.getByRole('button', { name: 'Abrir búsqueda' }).press('/')
    await frame.getByLabel('Buscar commits').fill('Bob')
    await frame.locator('tr[data-hash="a"]').press('ArrowDown')
    await frame.getByRole('complementary', { name: 'Detalles del commit' }).getByRole('heading', { name: 'Añadir explorador de commits', exact: true }).waitFor()
    assert.equal(await frame.locator('tr.selected').getAttribute('data-hash'), 'f')

    await frame.getByRole('button', { name: 'Limpiar', exact: true }).click()
    await frame.getByRole('button', { name: 'Filtros', exact: true }).click()
    await frame.getByLabel('Filtrar por rama').click()
    await frame.getByLabel('Buscar ramas').fill('FEAT')
    assert.equal(await frame.getByRole('listbox').getByRole('option').count(), 2)
    await frame.getByRole('option', { name: 'feature', exact: true }).click()
    await frame.locator('tr[data-hash="a"].dimmed').waitFor()
    await frame.getByLabel('Filtrar por autor').selectOption('Bob')
    await frame.locator('tr[data-hash="b"].dimmed').waitFor()
    await frame.getByLabel('Solo merges').check()
    await frame.getByText('Sin coincidencias. Cambia la búsqueda o limpia los filtros.').waitFor()
    await frame.locator('tr.selected').press('ArrowDown')
    assert.equal(await frame.locator('tr.selected').getAttribute('data-hash'), 'f')
    await frame.getByRole('button', { name: 'Limpiar', exact: true }).click()
    await frame.getByRole('button', { name: 'Ir a HEAD' }).click()
    assert.equal(await frame.getByLabel('Hash completo').inputValue(), 'a')
    assert.match(await frame.locator('.commit-message').textContent(), /Añade navegación por teclado y detalles/)
    await frame.getByRole('button', { name: 'Copiar hash' }).click()
    await frame.locator('.copy-message').filter({ hasText: /Hash copiado|Hash seleccionado/ }).waitFor()
    await frame.getByRole('button', { name: 'f', exact: true }).click()
    assert.equal(await frame.locator('tr.selected').getAttribute('data-hash'), 'f')
    await frame.locator('tr[data-hash="WORKING_TREE"]').click()
    await frame.locator('.changes-list').getByText('details.tsx', { exact: true }).waitFor()
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

test('archivos y diffs permiten comparar padres y navegar con teclado bajo CSP en sidebar estrecha', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 260, height: 720 } })
    page.setDefaultTimeout(5000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    const file = { path: '--special & café [1].txt', oldPath: 'old\t\n<script>.txt', status: 'R100', binary: false, patch: 'diff --git a/old b/new\n@@ -1 +1 @@\n-before\n+</script><img src=x onerror=alert(1)>\n' }
    const comparisons = [
      { label: 'Padre 1: base-a', base: 'base-a', target: 'merge', files: [file, { path: 'binary.bin', status: 'M', binary: true, patch: '' }, { path: 'large.txt', status: 'A', binary: false, patch: '+large\n', notice: 'Diff recortado: máximo 16 KiB / 600 líneas por archivo.' }], notice: 'Lista recortada: máximo 100 archivos.' },
      { label: 'Padre 2: base-b', base: 'base-b', target: 'merge', files: [{ path: 'other.txt', status: 'D', binary: false, patch: '-other\n' }] },
    ]
    const history = [{ ...commit('merge', ['base-a', 'base-b']), comparisons }, { ...commit('stash', ['base-a']), stash: 'stash@{0}', comparisons: [{ label: 'Stash: archivos sin seguimiento', base: null, target: 'snapshot', files: [{ ...file, oldPath: undefined, status: 'A' }] }] }, { ...commit('omitted', []), diffNotice: 'Comparación no precargada: límite del panel de 4 MiB.' }]
    const html = renderHtml({ repo: '/repo', branch: 'main', head: 'merge', rows: layout(history) })
    await page.setContent('<iframe id="panel" sandbox="allow-scripts" style="border:0;width:100%;height:700px"></iframe>')
    await page.locator('#panel').evaluate((element, srcdoc) => { element.srcdoc = srcdoc }, `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head>${html}`)
    const frame = page.frameLocator('#panel')
    await frame.locator('tr[data-hash="merge"]').click()
    await frame.getByRole('separator', { name: 'Ajustar altura de los detalles' }).press('End')
    assert.equal(await frame.getByLabel('Comparación del diff').inputValue(), '0')
    const summary = frame.locator('.commit-file summary').first()
    await summary.focus()
    await summary.press('Enter')
    const patch = frame.getByRole('region', { name: 'Diff de --special & café [1].txt', exact: true })
    assert.equal(await patch.isVisible(), true)
    assert.match(await patch.innerText(), /<\/script><img src=x onerror=alert\(1\)>/)
    assert.equal(await frame.locator('.commit-files img').count(), 0)
    await patch.focus()
    await patch.press('ArrowRight')
    await frame.locator('.commit-file summary').filter({ hasText: 'binary.bin' }).press('Enter')
    assert.equal(await frame.getByText('Archivo binario: no se muestra un diff de texto.', { exact: true }).isVisible(), true)
    await frame.locator('.commit-file summary').filter({ hasText: 'large.txt' }).press('Enter')
    assert.equal(await frame.getByText('Diff recortado: máximo 16 KiB / 600 líneas por archivo.', { exact: true }).isVisible(), true)
    assert.equal(await frame.getByText('Lista recortada: máximo 100 archivos.', { exact: true }).isVisible(), true)
    assert.equal(await frame.locator('body').evaluate(element => element.scrollWidth <= document.documentElement.clientWidth), true)
    await frame.getByLabel('Comparación del diff').focus()
    await frame.getByLabel('Comparación del diff').selectOption('1')
    assert.equal(await frame.locator('.commit-file summary').count(), 1)
    assert.match(await frame.locator('.commit-file summary').innerText(), /other.txt/)
    await frame.locator('.commit-file summary').press('Enter')
    assert.equal(await frame.getByRole('region', { name: 'Diff de other.txt' }).isVisible(), true)
    await frame.locator('tr[data-hash="stash"]').click()
    assert.equal(await frame.getByText('Stash: archivos sin seguimiento', { exact: true }).isVisible(), true)
    assert.equal(await frame.getByLabel('Comparación del diff').count(), 0)
    await frame.locator('tr[data-hash="omitted"]').click()
    assert.equal(await frame.getByText('Comparación no precargada: límite del panel de 4 MiB.', { exact: true }).isVisible(), true)
    await frame.getByRole('button', { name: 'Cerrar detalles' }).press('Escape')
    assert.equal(await frame.locator('.details').count(), 0)
    assert.equal(await frame.locator('tr[data-hash="omitted"]').evaluate(element => element === document.activeElement), true)
    await frame.locator('tr[data-hash="merge"]').click()
    assert.equal(await frame.getByLabel('Comparación del diff').inputValue(), '0')
    await mkdir('test-artifacts', { recursive: true })
    await page.screenshot({ path: 'test-artifacts/commit-files-diff.png' })
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})
