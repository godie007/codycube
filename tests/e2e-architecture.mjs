// Prueba de la vista de arquitectura contra Dapr real, en un clúster DESECHABLE con tests/dapr-demo.yaml.
// Se niega a correr con un contexto que no se llame "codycube-test".
//
//   KUBECONFIG=/ruta/test.yaml CODYCUBE_E2E_OUT=/ruta/capturas node tests/e2e-architecture.mjs
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { selectNamespaces } from './namespaces.mjs'

const kubeconfig = process.env.KUBECONFIG
const kubectl = (...args) => execFileSync('kubectl', ['--kubeconfig', kubeconfig, ...args], { encoding: 'utf8' }).trim()
if (kubectl('config', 'current-context') !== 'codycube-test') throw new Error('Solo corre contra el clúster desechable codycube-test')

const out = process.env.CODYCUBE_E2E_OUT ?? mkdtempSync(join(tmpdir(), 'codycube-arch-'))
mkdirSync(out, { recursive: true })
const results = []
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const W = (name) => `workload:tienda/Deployment/${name}`
const EDGES = {
  gatewayOrders: `invoke|${W('gateway')}|${W('orders')}`,
  ordersPayments: `invoke|${W('orders')}|${W('payments')}`,
  publish: `publish|${W('orders')}|topic:tienda/pubsub/pedidos`,
  deliverNotifications: `deliver|topic:tienda/pubsub/pedidos|${W('notifications')}`,
  deliverInventory: `deliver|topic:tienda/pubsub/pedidos|${W('inventory')}`,
  state: `component|${W('orders')}|component:tienda/statestore`
}

async function open(config) {
  const userData = mkdtempSync(join(tmpdir(), 'codycube-e2e-'))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, CODYCUBE_USER_DATA: userData, KUBECONFIG: config, ELECTRON_RENDERER_URL: '' } })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => message.type() === 'error' && errors.push(`console: ${message.text()}`))
  await page.setViewportSize({ width: 1500, height: 920 }).catch(() => {})
  page.setDefaultTimeout(30_000)
  await page.locator('.context', { hasText: 'codycube-test' }).getByRole('button', { name: 'Conectar' }).click()
  await selectNamespaces(page, ['tienda'])
  await page.locator('.side-item', { hasText: /^Arquitectura$/ }).click()
  return { app, page, errors, close: async () => { await app.close().catch(() => {}); rmSync(userData, { recursive: true, force: true }) } }
}

const main = await open(kubeconfig)
const { page } = main
const shot = (name, target = page) => target.screenshot({ path: join(out, `${name}.png`) })
const step = async (name, fn) => {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  ✓ ${name}`)
  } catch (error) {
    results.push({ name, ok: false })
    console.log(`  ✗ ${name}: ${error.message.split('\n').slice(0, 3).join(' | ')}`)
    await shot(`fallo-${results.length}`).catch(() => {})
  }
}
const until = async (check, what, ms = 60_000) => {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try {
      last = await check()
      if (last) return last
    } catch (error) {
      last = error.message
    }
    await sleep(400)
  }
  throw new Error(`No se cumplió: ${what} (último: ${JSON.stringify(last)})`)
}
const edge = (id) => page.locator(`[data-edge="${id}"]`)
const edgeHealth = (id) => edge(id).getAttribute('class')
const clickEdge = async (id) => {
  // Con el ratón de verdad, sobre un punto del trazado: comprueba que la zona de clic funciona
  const point = await edge(id).locator('.gedge-hit').evaluate((path) => {
    const p = path.getPointAtLength(path.getTotalLength() * 0.3).matrixTransform(path.getScreenCTM())
    return { x: p.x, y: p.y }
  })
  await page.mouse.click(point.x, point.y)
}
const inspector = () => page.getByTestId('inspector')
const positions = () => page.locator('.gnode').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-node') + n.getAttribute('transform')).sort().join())

/** Contador real del sidecar, leído sin pasar por la app, para contrastar lo que muestra */
const rawCounter = () => {
  const pod = kubectl('-n', 'tienda', 'get', 'pods', '-l', 'app=gateway', '-o', 'jsonpath={.items[0].metadata.name}')
  const text = kubectl('get', '--raw', `/api/v1/namespaces/tienda/pods/${pod}:9090/proxy/metrics`)
  return text.split('\n').filter((l) => l.startsWith('dapr_runtime_service_invocation_res_recv_total{')).reduce((sum, l) => sum + Number(l.split(' ').pop()), 0)
}
const number = (text) => Number(text.replace(/\s/g, '').replace(/\./g, '').replace(',', '.').replace('<', ''))

try {
  await step('dibuja la arquitectura declarada: Ingress, Service, cargas, broker, tema y Redis', async () => {
    for (const name of ['tienda', 'gateway', 'orders', 'payments', 'notifications', 'inventory', 'reports', 'redis', 'pubsub', 'statestore', 'pedidos']) {
      await page.locator(`[data-node="${name}"]`).first().waitFor()
    }
    if (await page.locator('[data-node$="-dapr"]').count()) throw new Error('Se ven los Services internos de Dapr')
    await page.locator(`[data-edge="route|ingress:tienda/tienda|${W('gateway')}"]`).waitFor({ state: 'attached' })
    const declared = await page.locator(`[data-edge="declared|${W('reports')}|${W('orders')}"]`).getAttribute('class')
    if (!declared.includes('gedge-declared')) throw new Error(`reports → orders debería ser declarada: ${declared}`)
    await page.locator(`[data-edge="declared|component:tienda/pubsub|${W('redis')}"]`).waitFor({ state: 'attached' })
  })

  await step('pasa a medir tráfico real en todos los caminos', async () => {
    await until(async () => (await page.getByTestId('live-state').innerText()).includes('En vivo'), 'estado en vivo')
    for (const id of Object.values(EDGES)) {
      await until(async () => {
        const c = await edgeHealth(id)
        return c && !c.includes('gedge-idle') && !c.includes('gedge-declared')
      }, `tráfico en ${id}`)
    }
    if ((await page.locator('.gedge-particle').count()) === 0) throw new Error('Sin partículas animadas')
    await until(async () => number((await page.getByTestId('kpis').locator('.stat-value').first().innerText())) > 0, 'KPI de invocaciones')
    if (!(await page.getByTestId('kpis').innerText()).includes('6/6')) throw new Error(`Sidecars: ${await page.getByTestId('kpis').innerText()}`)
    await sleep(600)
    await shot('10-arquitectura')
  })

  await step('payments falla un 10 %: esa conexión se marca, con el porcentaje escrito', async () => {
    await until(async () => (await edgeHealth(EDGES.ordersPayments)).includes('gedge-bad') || (await edgeHealth(EDGES.ordersPayments)).includes('gedge-warn'), 'conexión degradada', 90_000)
    await until(async () => (await page.locator('.edge-label', { hasText: '▲' }).count()) > 0, 'etiqueta con % de error')
  })

  await step('el diagrama no se recoloca entre lecturas', async () => {
    const before = await positions()
    await sleep(23_000)
    if ((await positions()) !== before) throw new Error('Los nodos se movieron')
  })

  await step('el detalle de una conexión da tasa, errores, latencia y desglose', async () => {
    await clickEdge(EDGES.ordersPayments)
    await inspector().waitFor()
    const text = await inspector().innerText()
    for (const expected of ['orders → payments', 'Invocación de servicio', 'HTTP 200', 'HTTP 500', 'p95', 'Medido por los sidecars']) {
      if (!text.includes(expected)) throw new Error(`Falta «${expected}» en: ${text}`)
    }
    const p95 = await inspector().locator('.stat', { hasText: 'latencia p95' }).locator('.stat-value').innerText()
    if (!/\d+ ms/.test(p95)) throw new Error(`p95: ${p95}`)
    await until(async () => (await inspector().locator('.chart-line').count()) > 0, 'gráfica')
    await shot('11-detalle-conexion')
    await inspector().getByRole('button', { name: 'Cerrar panel' }).click()
  })

  await step('la tabla coincide con los contadores reales del sidecar', async () => {
    await page.getByRole('button', { name: 'Tabla' }).click()
    const row = page.getByTestId('connections').locator('tr', { hasText: 'Invocación de servicio' }).filter({ hasText: 'gateway' }).first()
    await row.waitFor()
    const a = rawCounter()
    await sleep(30_000)
    const b = rawCounter()
    const real = (b - a) / 30
    const cells = await row.locator('td').allInnerTexts()
    const shown = number(cells[3])
    const total = number(cells[7])
    if (Math.abs(shown - real) > Math.max(0.6, real * 0.3)) throw new Error(`Muestra ${shown}/s y el sidecar da ${real.toFixed(2)}/s`)
    if (total < a || total > b + 60) throw new Error(`Acumulado ${total}; contador real entre ${a} y ${b}`)
    console.log(`    gateway → orders: pantalla ${shown}/s, sidecar ${real.toFixed(2)}/s; acumulado ${total} (real ${b})`)
    await shot('12-tabla')
    await page.getByRole('button', { name: 'Diagrama' }).click()
  })

  await step('el detalle de un nodo enlaza con su objeto de Kubernetes', async () => {
    await page.locator(`.gnode-workload[data-node="payments"]`).click()
    const text = await inspector().innerText()
    for (const expected of ['payments', 'RECIBE DE', 'orders', 'App ID']) if (!text.includes(expected)) throw new Error(`Falta ${expected}: ${text}`)
    await shot('13-detalle-nodo')
    await inspector().getByRole('button', { name: 'Abrir Deployment' }).click()
    await page.locator('aside.details', { hasText: 'payments' }).waitFor()
    await page.locator('.side-item', { hasText: /^Arquitectura$/ }).click()
    await page.locator('.gnode').first().waitFor()
  })

  await step('los filtros quitan lo declarado sin tocar lo medido', async () => {
    await page.getByLabel('Solo con tráfico medido').check()
    await until(async () => (await page.locator('[data-node="reports"]').count()) === 0, 'reports desaparece')
    if ((await page.locator(`[data-edge="${EDGES.publish}"]`).count()) !== 1) throw new Error('Se perdió tráfico medido')
    await sleep(500)
    await shot('14-solo-medido')
    await page.getByLabel('Solo con tráfico medido').uncheck()
    await page.locator('[data-node="reports"]').first().waitFor()
  })

  await step('la búsqueda resalta el servicio', async () => {
    await page.getByLabel('Buscar en el diagrama').fill('notif')
    if ((await page.locator('.gnode.matched').count()) !== 1) throw new Error('No resalta')
    await page.getByLabel('Buscar en el diagrama').fill('')
  })

  await step('con todos los namespaces y el sistema agrupa por namespace sin romperse', async () => {
    await selectNamespaces(page, [])
    await page.getByLabel('Sistema').check()
    await page.locator('.ggroup', { hasText: 'dapr-system' }).waitFor()
    await page.locator('.ggroup', { hasText: 'tienda' }).waitFor()
    await page.locator(`[data-edge="${EDGES.gatewayOrders}"]`).waitFor({ state: 'attached' })
    await sleep(700)
    await shot('17-todos-los-namespaces')
    await page.getByLabel('Sistema').uncheck()
    await selectNamespaces(page, ['tienda'])
    await until(async () => (await page.getByTestId('live-state').innerText()).includes('En vivo'), 'vuelve a medir')
  })

  await step('con dos namespaces elegidos lista ambos y uno de sistema elegido se ve aunque «Sistema» esté apagado', async () => {
    await selectNamespaces(page, ['dapr-system', 'tienda'])
    if ((await page.getByLabel('Sistema').isChecked())) throw new Error('Sistema debería seguir apagado')
    await page.locator('.ggroup', { hasText: 'dapr-system' }).waitFor()
    await page.locator('.ggroup', { hasText: 'tienda' }).waitFor()
    await page.locator(`[data-edge="${EDGES.gatewayOrders}"]`).waitFor({ state: 'attached' })
    await until(async () => (await page.getByTestId('live-state').innerText()).includes('En vivo'), 'mide con dos namespaces')
    await shot('18-dos-namespaces')
    await selectNamespaces(page, ['tienda'])
    await until(async () => (await page.locator('.ggroup', { hasText: 'dapr-system' }).count()) === 0, 'quita dapr-system')
  })

  await step('un destino caído se ve: la conexión en rojo, sin entregar, y 0/0 pods', async () => {
    kubectl('-n', 'tienda', 'scale', 'deploy/payments', '--replicas=0')
    try {
      await until(async () => (await page.locator('.gnode-workload[data-node="payments"]').textContent()).includes('0/0 pods'), 'payments a cero', 60_000)
      await clickEdge(EDGES.ordersPayments)
      await until(async () => (await inspector().innerText()).includes('No entregada'), 'llamadas sin entregar en el desglose', 60_000)
      await until(async () => (await edgeHealth(EDGES.ordersPayments)).includes('gedge-bad'), 'conexión en rojo', 60_000)
      console.log(`    desglose con payments caído: ${(await inspector().locator('table').first().innerText()).replace(/\s+/g, ' ')}`)
      await shot('15-destino-caido')
      await inspector().getByRole('button', { name: 'Cerrar panel' }).click()
    } finally {
      kubectl('-n', 'tienda', 'scale', 'deploy/payments', '--replicas=1')
    }
    await until(async () => (await page.locator('.gnode-workload[data-node="payments"]').textContent()).includes('1/1 pods'), 'payments se recupera', 90_000)
  })

  const countTraffic = async (ms) => {
    await page.evaluate(() => {
      window.__traffic = 0
      window.__stop?.()
      window.__stop = window.codycube.onTraffic(() => window.__traffic++)
    })
    await sleep(ms)
    return page.evaluate(() => window.__traffic)
  }

  await step('en pausa no hay lecturas ni animación, y al salir de la vista tampoco', async () => {
    await page.getByRole('button', { name: 'Pausar' }).click()
    await sleep(300)
    if ((await page.locator('.gedge-particle').count()) !== 0) throw new Error('Sigue animando en pausa')
    if ((await countTraffic(12_000)) !== 0) throw new Error('Sigue leyendo en pausa')
    await page.getByRole('button', { name: 'Reanudar' }).click()
    if ((await countTraffic(12_000)) === 0) throw new Error('No reanudó')
    await page.locator('.side-item', { hasText: /^Pods$/ }).click()
    await sleep(500)
    if ((await countTraffic(12_000)) !== 0) throw new Error('Sigue leyendo fuera de la vista')
  })

  await step('un namespace sin nada lo dice en lugar de dibujar un grafo vacío', async () => {
    await selectNamespaces(page, ['kube-public'])
    await page.locator('.side-item', { hasText: /^Arquitectura$/ }).click()
    await page.locator('.empty', { hasText: 'Nada que mostrar' }).waitFor()
    await selectNamespaces(page, ['tienda'])
    await page.locator('[data-node="gateway"]').first().waitFor()
  })

  await main.close()

  // Usuario que puede ver pero no leer métricas: el rol `view` no incluye pods/proxy
  await step('sin permiso pods/proxy muestra la arquitectura y explica por qué no hay tráfico', async () => {
    kubectl('-n', 'tienda', 'create', 'serviceaccount', 'solo-ver', '--dry-run=client', '-o', 'name')
    execFileSync('kubectl', ['--kubeconfig', kubeconfig, 'apply', '-f', '-'], {
      input: `apiVersion: v1\nkind: ServiceAccount\nmetadata: { name: solo-ver, namespace: tienda }\n---\napiVersion: rbac.authorization.k8s.io/v1\nkind: RoleBinding\nmetadata: { name: solo-ver, namespace: tienda }\nroleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: view }\nsubjects: [{ kind: ServiceAccount, name: solo-ver, namespace: tienda }]\n`
    })
    const token = kubectl('-n', 'tienda', 'create', 'token', 'solo-ver')
    const server = kubectl('config', 'view', '--minify', '-o', 'jsonpath={.clusters[0].cluster.server}')
    const dir = mkdtempSync(join(tmpdir(), 'codycube-rbac-'))
    const limited = join(dir, 'config.yaml')
    writeFileSync(limited, `apiVersion: v1\nkind: Config\ncurrent-context: codycube-test\nclusters: [{ name: c, cluster: { server: "${server}", insecure-skip-tls-verify: true } }]\nusers: [{ name: u, user: { token: "${token}" } }]\ncontexts: [{ name: codycube-test, context: { cluster: c, user: u, namespace: tienda } }]\n`)
    const second = await open(limited)
    try {
      await second.page.locator('[data-node="gateway"]').first().waitFor()
      await second.page.getByTestId('coverage-warning').filter({ hasText: 'pods/proxy' }).waitFor()
      await until(async () => (await second.page.getByTestId('live-state').innerText()).includes('Sin medición'), 'no dice que está en vivo')
      await shot('16-sin-permiso', second.page)
    } finally {
      await second.close()
      rmSync(dir, { recursive: true, force: true })
      kubectl('-n', 'tienda', 'delete', 'rolebinding,serviceaccount', 'solo-ver')
    }
  })
} finally {
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} pasos correctos. Capturas en ${out}`)
  const realErrors = main.errors.filter((e) => !/Failed to load resource/.test(e))
  if (realErrors.length) console.log(`Errores en la interfaz:\n  ${[...new Set(realErrors)].slice(0, 15).join('\n  ')}`)
  await main.close()
  process.exitCode = failed.length || realErrors.length ? 1 : 0
}
