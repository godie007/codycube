// Recorre la app a varios tamaños de ventana y mide problemas de distribución: controles fuera de la
// ventana, contenido aplastado, solapes y diagramas ilegibles. Exige el clúster desechable codycube-test
// con tests/dapr-demo.yaml.
//
//   KUBECONFIG=/ruta/test.yaml CODYCUBE_E2E_OUT=/ruta/capturas node tests/e2e-responsive.mjs
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { selectNamespaces } from './namespaces.mjs'

const kubeconfig = process.env.KUBECONFIG
if (execFileSync('kubectl', ['--kubeconfig', kubeconfig, 'config', 'current-context'], { encoding: 'utf8' }).trim() !== 'codycube-test') throw new Error('Solo corre contra codycube-test')
const out = process.env.CODYCUBE_E2E_OUT ?? mkdtempSync(join(tmpdir(), 'codycube-resp-'))
mkdirSync(out, { recursive: true })
const SIZES = [[1920, 1080], [1440, 900], [1200, 760], [960, 600]]
const userData = mkdtempSync(join(tmpdir(), 'codycube-e2e-'))
const app = await electron.launch({ args: ['.'], env: { ...process.env, CODYCUBE_USER_DATA: userData, KUBECONFIG: kubeconfig, ELECTRON_RENDERER_URL: '' } })
const page = await app.firstWindow()
page.setDefaultTimeout(30_000)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const problems = []
let checks = 0

const resize = async (width, height) => {
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [width, height])
  await sleep(500)
}
/** Mide en la página lo que se ha salido de su sitio */
const audit = async (label) => {
  checks++
  const found = await page.evaluate(() => {
    const issues = []
    const [W, H] = [window.innerWidth, window.innerHeight]
    if (document.documentElement.scrollWidth > W + 1) issues.push(`la página desborda: ${document.documentElement.scrollWidth} > ${W}`)
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' }
    const name = (el) => `${el.tagName.toLowerCase()}.${String(el.className.baseVal ?? el.className).split(' ')[0]} «${(el.innerText ?? el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 24)}»`
    for (const el of document.querySelectorAll('.toolbar button, .toolbar select, .toolbar input, .arch-filters label, .arch-filters .stat, .actions button, .details-head button, .graph-zoom button, .readonly-toggle')) {
      if (!visible(el)) continue
      const r = el.getBoundingClientRect()
      if (r.right > W + 1 || r.bottom > H + 1 || r.left < 0) issues.push(`fuera de la ventana: ${name(el)} (${Math.round(r.left)}–${Math.round(r.right)} de ${W})`)
    }
    // Dentro de una misma barra, dos controles no deben pisarse
    for (const bar of document.querySelectorAll('.toolbar, .arch-filters, .actions')) {
      const items = [...bar.querySelectorAll(':scope > *')].filter(visible).map((el) => ({ el, r: el.getBoundingClientRect() }))
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
        const [a, b] = [items[i].r, items[j].r]
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) issues.push(`se pisan: ${name(items[i].el)} y ${name(items[j].el)}`)
      }
    }
    const main = document.querySelector('.content-main')
    if (main && visible(main) && main.getBoundingClientRect().width < 380) issues.push(`contenido aplastado: ${Math.round(main.getBoundingClientRect().width)} px`)
    const graph = document.querySelector('.graph')
    if (graph && visible(graph)) {
      const rect = graph.getBoundingClientRect()
      if (rect.height < 220) issues.push(`diagrama sin altura: ${Math.round(rect.height)} px`)
      const layer = graph.querySelector('svg > g')
      const scale = Number(/scale\(([\d.]+)\)/.exec(layer?.getAttribute('transform') ?? '')?.[1] ?? 1)
      if (scale < 0.54) issues.push(`diagrama ilegible: escala ${scale.toFixed(2)}`)
    }
    return issues
  })
  for (const issue of found) problems.push(`${label}: ${issue}`)
  console.log(`  ${found.length ? '✗' : '✓'} ${label}${found.length ? `\n      ${found.join('\n      ')}` : ''}`)
}

try {
  await page.locator('.context', { hasText: 'codycube-test' }).waitFor()

  // El logo: se ve en grande en el inicio y sus fotogramas cambian, es decir, se mueve de verdad
  for (const selector of ['.home-hero', '.home-logo', '.hot-logo img']) {
    const element = page.locator(selector)
    if (!(await element.evaluate((img) => img.complete && img.naturalWidth > 0))) problems.push(`${selector} no carga`)
    const first = await element.screenshot()
    await sleep(700)
    if (first.equals(await element.screenshot())) problems.push(`${selector} está quieto`)
  }
  await resize(1440, 900)
  await page.locator('.home-hero').screenshot({ path: join(out, 'imagen.png') })
  for (const [w, h] of SIZES) {
    await resize(w, h)
    await audit(`${w}×${h} inicio`)
  }
  await page.locator('.context', { hasText: 'codycube-test' }).getByRole('button', { name: 'Conectar' }).click()
  await selectNamespaces(page, ['tienda'])
  await page.locator('.side-item', { hasText: /^Arquitectura$/ }).click()
  await page.locator('.gnode').first().waitFor()
  await page.getByTestId('live-state').filter({ hasText: 'En vivo' }).waitFor({ timeout: 45_000 })

  for (const [w, h] of SIZES) {
    const tag = `${w}x${h}`
    await resize(w, h)
    await page.locator('.side-item', { hasText: /^Arquitectura$/ }).click()
    await page.getByRole('button', { name: 'Diagrama' }).click()
    await page.getByRole('button', { name: 'Ajustar a la ventana' }).click()
    await sleep(900)
    await audit(`${tag} diagrama`)
    await page.screenshot({ path: join(out, `${tag}-diagrama.png`) })

    await page.locator('.gnode-workload[data-node="payments"]').click()
    await sleep(300)
    await audit(`${tag} diagrama con panel`)
    // Lo seleccionado sigue a la vista, no debajo del panel
    const [node, panel] = await Promise.all([page.locator('.gnode-workload[data-node="payments"]').boundingBox(), page.getByTestId('inspector').boundingBox()])
    if (node.x + node.width / 2 > panel.x) problems.push(`${tag}: el panel tapa lo seleccionado`)
    await page.screenshot({ path: join(out, `${tag}-panel.png`) })
    await page.getByRole('button', { name: 'Cerrar panel' }).click()

    await page.getByRole('button', { name: 'Tabla' }).click()
    await sleep(200)
    await audit(`${tag} tabla de conexiones`)

    await page.locator('.side-item', { hasText: /^Resumen$/ }).click()
    await sleep(400)
    await audit(`${tag} resumen`)
    await page.screenshot({ path: join(out, `${tag}-resumen.png`) })

    await page.locator('.side-item', { hasText: /^Deployments$/ }).click()
    await page.locator('.grid-row').first().waitFor()
    await audit(`${tag} tabla de recursos`)
    await page.locator('.grid-row').first().click()
    await page.locator('aside.details').waitFor()
    await sleep(300)
    await audit(`${tag} detalles`)
    await page.screenshot({ path: join(out, `${tag}-detalles.png`) })
    await page.locator('aside.details').getByRole('button', { name: 'Cerrar detalles' }).click()
  }

  // Con registros abiertos en la ventana mínima
  await resize(960, 600)
  await page.locator('.side-item', { hasText: /^Pods$/ }).click()
  await page.locator('.grid-row', { hasText: 'orders' }).first().click()
  await page.locator('aside.details .actions .btn', { hasText: /^Registros$/ }).click()
  await page.locator('.dock').waitFor()
  await sleep(600)
  await audit('960x600 con registros abiertos')
  await page.screenshot({ path: join(out, '960x600-registros.png') })
} finally {
  console.log(`\n${checks} revisiones, ${problems.length} problemas. Capturas en ${out}`)
  for (const p of problems) console.log(`  - ${p}`)
  await app.close().catch(() => {})
  rmSync(userData, { recursive: true, force: true })
  process.exitCode = problems.length ? 1 : 0
}
